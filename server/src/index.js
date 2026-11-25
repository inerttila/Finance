import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { hexclaveServerApp } from "./hexclave/server.js";
import { resolveFiscalInvoice } from "./invoice.js";
import { CATEGORIES, categorize, isWeekendIso } from "./parse.js";
import { ensureSchema } from "./schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile() {
  const envPath = path.resolve(__dirname, "../../.env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

loadEnvFile();

const databaseUrl = process.env.DATABASE_URL || "postgres://finance:finance@127.0.0.1:5555/finance";
const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: /neon\.tech|sslmode=require/i.test(databaseUrl)
    ? { rejectUnauthorized: false }
    : undefined,
});

const clientDist = path.resolve(__dirname, "../../client/dist");
const port = Number(process.env.PORT) || 3001;
const host = process.env.HOST || "127.0.0.1";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

function lek(amount) {
  return `${Math.round(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")} L`;
}

function monthBounds(month) {
  const [yearText, monthText] = String(month).split("-");
  const year = Number(yearText);
  const monthNumber = Number(monthText);
  if (!year || monthNumber < 1 || monthNumber > 12) return null;
  const key = `${year}-${String(monthNumber).padStart(2, "0")}`;
  const start = `${key}-01`;
  const next = monthNumber === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(monthNumber + 1).padStart(2, "0")}-01`;
  return { key, start, next };
}

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function todayIso() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function shiftMonth(key, delta) {
  const [year, month] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function resolveNextMonth(latest, force) {
  const today = todayKey();
  if (!latest) return today;
  if (today > latest.month) return today;
  if (force && latest.count > 0) return shiftMonth(latest.month, 1);
  return latest.month;
}

function parseAmountInput(value) {
  const text = String(value ?? "").trim().replace(/\s/g, "");
  if (!/^\d+$/.test(text)) return null;
  const amount = Number(text);
  if (amount <= 0 || amount > 100_000_000) return null;
  return amount;
}

function mapTx(row) {
  return {
    id: row.id,
    amount: row.amount,
    description: row.description,
    category: row.category_slug,
    people: row.people || [],
    spentOn: row.spent_on,
    weekend: row.weekend,
    fixed: row.fixed,
    fixedTemplateId: row.fixed_template_id || null,
  };
}

function mapFixedTemplate(row) {
  return {
    id: row.id,
    amount: row.amount,
    description: row.description,
    category: row.category_slug,
    dayOfMonth: row.day_of_month,
    active: row.active,
  };
}

function daysInMonthKey(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function spentOnForTemplate(monthKey, dayOfMonth) {
  const last = daysInMonthKey(monthKey);
  const day = Math.min(Math.max(1, Number(dayOfMonth) || 1), last);
  return `${monthKey}-${String(day).padStart(2, "0")}`;
}

async function listFixedTemplates(userId) {
  const { rows } = await pool.query(
    `select id, amount, description, category_slug, day_of_month, active
     from fixed_templates
     where user_id = $1
     order by sort_order, id`,
    [userId],
  );
  return rows.map(mapFixedTemplate);
}

async function createFixedTemplateRow(
  userId,
  { amount, description, category, dayOfMonth },
) {
  const { rows: orderRows } = await pool.query(
    "select coalesce(max(sort_order), 0) + 1 as next from fixed_templates where user_id = $1",
    [userId],
  );
  const created = await pool.query(
    `insert into fixed_templates
      (user_id, amount, description, category_slug, day_of_month, active, sort_order)
     values ($1, $2, $3, $4, $5, true, $6)
     returning id`,
    [userId, amount, description, category, dayOfMonth, orderRows[0].next],
  );
  return created.rows[0].id;
}

async function ensureFixedForMonth(userId, monthKey) {
  const bounds = monthBounds(monthKey);
  if (!bounds) return 0;
  const today = todayIso();
  const todayMonth = today.slice(0, 7);
  // Never post into a future month. For the current month, wait until the day.
  if (monthKey > todayMonth) return 0;
  // Never rewrite past months when browsing — only the open month gets fixed lines.
  const summaries = await monthSummaries(userId);
  const openMonth = summaries[0]?.month;
  if (openMonth && monthKey !== openMonth) return 0;

  const { rows: templates } = await pool.query(
    `select id, amount, description, category_slug, day_of_month
     from fixed_templates
     where user_id = $1 and active = true
     order by sort_order, id`,
    [userId],
  );
  if (!templates.length) return 0;

  let created = 0;
  for (const template of templates) {
    const spentOn = spentOnForTemplate(bounds.key, template.day_of_month);
    if (monthKey === todayMonth && spentOn > today) continue;

    const exists = await pool.query(
      `select 1 from transactions
       where user_id = $1
         and fixed_template_id = $2
         and spent_on >= $3::date
         and spent_on < $4::date
       limit 1`,
      [userId, template.id, bounds.start, bounds.next],
    );
    if (exists.rowCount) continue;

    const { rows } = await pool.query(
      "select coalesce(max(sort_order), 0) + 1 as next from transactions where user_id = $1",
      [userId],
    );
    await pool.query(
      `insert into transactions
        (user_id, amount, description, category_slug, people, spent_on, weekend, sort_order, fixed, fixed_template_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)`,
      [
        userId,
        template.amount,
        template.description,
        template.category_slug,
        [],
        spentOn,
        isWeekendIso(spentOn),
        rows[0].next,
        template.id,
      ],
    );
    created += 1;
  }
  return created;
}

async function categoryExists(userId, slug) {
  const { rowCount } = await pool.query(
    "select 1 from categories where user_id = $1 and slug = $2",
    [userId, slug],
  );
  return rowCount > 0;
}

function cleanCategoryName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 40) return null;
  return name;
}

function slugify(name) {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return base || "category";
}

const NEW_COLORS = ["#9a4d6b", "#3f6b4a", "#6a5428", "#355c7d", "#7d4e2d", "#4a5d48", "#6b3f55", "#3d5a62"];

async function uniqueSlug(userId, base) {
  let slug = base;
  let n = 2;
  for (;;) {
    const found = await pool.query(
      "select 1 from categories where user_id = $1 and slug = $2",
      [userId, slug],
    );
    if (!found.rowCount) return slug;
    slug = `${base.slice(0, 28)}-${n}`;
    n += 1;
  }
}

async function seedCategoriesForUser(userId, list = CATEGORIES) {
  for (const [index, category] of list.entries()) {
    await pool.query(
      `insert into categories (user_id, slug, name, color, sort_order)
       values ($1, $2, $3, $4, $5)
       on conflict (user_id, slug) do update
       set name = excluded.name,
           color = excluded.color,
           sort_order = excluded.sort_order`,
      [userId, category.slug, category.name, category.color, index],
    );
  }
}

function normalizeCategorySetup(input) {
  const source = Array.isArray(input) && input.length ? input : CATEGORIES;
  const out = [];
  const seen = new Set();
  for (const [index, item] of source.entries()) {
    const name = cleanCategoryName(item?.name) || cleanCategoryName(item?.slug);
    if (!name) continue;
    let slug = slugify(String(item?.slug || name));
    if (seen.has(slug)) slug = `${slug}-${index + 1}`;
    seen.add(slug);
    const color = String(item?.color || "").trim() || NEW_COLORS[index % NEW_COLORS.length];
    out.push({ slug, name, color });
  }
  if (!out.some((item) => item.slug === "other")) {
    const fallback = CATEGORIES.find((item) => item.slug === "other");
    out.push({ slug: fallback.slug, name: fallback.name, color: fallback.color });
  }
  return out.length ? out : CATEGORIES.map((item) => ({ ...item }));
}

function mapUser(row) {
  return {
    id: row.id,
    name: row.name,
    authId: row.auth_id || null,
    initial: String(row.name || "?").trim().charAt(0).toUpperCase() || "?",
  };
}

function mapAuthUser(authUser) {
  return {
    id: authUser.id,
    email: authUser.primaryEmail || null,
    displayName: authUser.displayName || null,
  };
}

async function listUsers() {
  const { rows } = await pool.query("select id, name, auth_id from users order by id");
  return rows.map(mapUser);
}

async function getUser(id) {
  const { rows } = await pool.query(
    "select id, name, auth_id from users where id = $1",
    [id],
  );
  return rows[0] ? mapUser(rows[0]) : null;
}

async function getUserByAuthId(authId) {
  const { rows } = await pool.query(
    "select id, name, auth_id from users where auth_id = $1",
    [authId],
  );
  return rows[0] ? mapUser(rows[0]) : null;
}

async function requireAuthUser(req) {
  const authUser = await hexclaveServerApp.getUser({ tokenStore: req });
  if (!authUser) {
    const error = new Error("Sign in to continue.");
    error.status = 401;
    throw error;
  }
  return authUser;
}

async function resolveUserId(req) {
  const authUser = await requireAuthUser(req);
  const user = await getUserByAuthId(authUser.id);
  if (!user) {
    const error = new Error("Create your ledger first.");
    error.status = 404;
    throw error;
  }
  return user;
}

async function monthSummaries(userId) {
  const { rows } = await pool.query(`
    with months as (
      select month from income where user_id = $1
      union
      select date_trunc('month', spent_on)::date as month from transactions where user_id = $1
    )
    select to_char(m.month, 'YYYY-MM') as month,
           coalesce(i.amount, 0)::int as income,
           coalesce(i.site_amount, 0)::int as site,
           coalesce(t.spent, 0)::int as spent,
           coalesce(t.line_count, 0)::int as line_count
    from months m
    left join income i on i.month = m.month and i.user_id = $1
    left join (
      select date_trunc('month', spent_on)::date as month,
             sum(amount)::int as spent,
             count(*)::int as line_count
      from transactions
      where user_id = $1
      group by 1
    ) t on t.month = m.month
    order by m.month desc
  `, [userId]);
  const plain = rows.map((row) => ({
    month: row.month,
    income: row.income,
    site: row.site,
    spent: row.spent,
    count: row.line_count,
  }));
  return applyCarry(plain);
}

function applyCarry(summaries) {
  const ordered = [...summaries].sort((a, b) => a.month.localeCompare(b.month));
  let onHand = 0;
  let from = null;
  const enriched = new Map();
  for (const item of ordered) {
    const carried = onHand;
    const remaining = item.income + (item.site || 0) + carried - item.spent;
    enriched.set(item.month, {
      ...item,
      carried,
      carriedFrom: carried > 0 ? from : null,
      remaining,
    });
    onHand = Math.max(remaining, 0);
    from = item.month;
  }
  return summaries.map((item) => enriched.get(item.month));
}

async function ensureIncome(userId, monthKey, amount = null) {
  const bounds = monthBounds(monthKey);
  if (!bounds) return;
  const existing = await pool.query(
    "select amount from income where user_id = $1 and month = $2",
    [userId, bounds.start],
  );
  if (existing.rowCount) return;
  let net = amount;
  if (net == null) {
    const previous = await pool.query(
      "select amount from income where user_id = $1 and month < $2 order by month desc limit 1",
      [userId, bounds.start],
    );
    if (!previous.rowCount) return;
    net = previous.rows[0].amount;
  }
  await pool.query(
    `insert into income (user_id, month, amount, site_amount) values ($1, $2, $3, 0)
     on conflict (user_id, month) do nothing`,
    [userId, bounds.start, net],
  );
}

async function loadMonth(userId, month) {
  const user = await getUser(userId);
  if (!user) {
    const error = new Error("That user is gone.");
    error.status = 401;
    throw error;
  }

  const summaries = await monthSummaries(userId);
  const openMonth = summaries[0]?.month || month || todayKey();
  const key = month || openMonth;
  const bounds = monthBounds(key);
  if (!bounds) {
    const error = new Error("That month is not valid.");
    error.status = 400;
    throw error;
  }

  const [incomeResult, txResult, categoryResult, usageResult, fixedUsageResult] =
    await Promise.all([
      pool.query(
        "select amount, site_amount from income where user_id = $1 and month = $2",
        [userId, bounds.start],
      ),
      pool.query(
        `select id, amount, description, category_slug, people,
                to_char(spent_on, 'YYYY-MM-DD') as spent_on,
                weekend, fixed, fixed_template_id
         from transactions
         where user_id = $1 and spent_on >= $2 and spent_on < $3
         order by spent_on desc, sort_order desc, id desc`,
        [userId, bounds.start, bounds.next],
      ),
      pool.query(
        "select slug, name, color from categories where user_id = $1 order by sort_order, slug",
        [userId],
      ),
      pool.query(
        `select category_slug, count(*)::int as n
         from transactions
         where user_id = $1
         group by category_slug`,
        [userId],
      ),
      pool.query(
        `select category_slug, count(*)::int as n
         from fixed_templates
         where user_id = $1
         group by category_slug`,
        [userId],
      ),
    ]);

  const transactions = txResult.rows.map(mapTx);
  const income = incomeResult.rows[0]?.amount ?? 0;
  const site = incomeResult.rows[0]?.site_amount ?? 0;
  const spent = transactions.reduce((sum, tx) => sum + tx.amount, 0);
  const usageBySlug = new Map(
    usageResult.rows.map((row) => [row.category_slug, row.n]),
  );
  const fixedUsageBySlug = new Map(
    fixedUsageResult.rows.map((row) => [row.category_slug, row.n]),
  );
  const byCategory = categoryResult.rows.map((category) => {
    const rows = transactions.filter((tx) => tx.category === category.slug);
    const recordCount =
      (usageBySlug.get(category.slug) || 0) +
      (fixedUsageBySlug.get(category.slug) || 0);
    return {
      slug: category.slug,
      name: category.name,
      color: category.color,
      total: rows.reduce((sum, tx) => sum + tx.amount, 0),
      count: rows.length,
      recordCount,
      hasRecords: recordCount > 0,
    };
  });

  const personMap = new Map();
  for (const tx of transactions) {
    for (const person of tx.people) {
      const current = personMap.get(person) || { name: person, total: 0, count: 0 };
      current.total += tx.amount;
      current.count += 1;
      personMap.set(person, current);
    }
  }

  const peopleTotal = byCategory.find((category) => category.slug === "people")?.total ?? 0;
  const bankTotal = byCategory.find((category) => category.slug === "bank")?.total ?? 0;
  const fixedTotal = transactions
    .filter((tx) => tx.fixed)
    .reduce((sum, tx) => sum + tx.amount, 0);
  const weekend = transactions.filter((tx) => tx.weekend).reduce((sum, tx) => sum + tx.amount, 0);
  const largest = transactions.reduce((best, tx) => (tx.amount > (best?.amount ?? -1) ? tx : best), null);
  const busiest = [...byCategory].filter((category) => category.count > 0).sort((a, b) => b.count - a.count)[0];
  const fuel = byCategory.find((category) => category.slug === "fuel");

  const insights = [];
  if (largest) insights.push(`${lek(largest.amount)} on “${largest.description}” is the biggest line.`);
  if (busiest) {
    const noun = busiest.count === 1 ? "line" : "lines";
    insights.push(`${busiest.name} is on ${busiest.count} ${noun}.`);
  }
  if (fuel?.total) insights.push(`Fuel for the car and motorcycle comes to ${lek(fuel.total)}.`);

  const viewed = summaries.find((item) => item.month === bounds.key);
  const carried = viewed?.carried ?? 0;
  const monthList = summaries.map((item) => ({ ...item, open: item.month === openMonth }));

  return {
    user,
    month: bounds.key,
    months: summaries.map((item) => item.month).sort(),
    monthList,
    openMonth,
    pastMonth: summaries.find((item) => item.month !== openMonth)?.month ?? null,
    closed: bounds.key !== openMonth,
    income,
    site,
    carried,
    carriedFrom: viewed?.carriedFrom ?? null,
    spent,
    remaining: income + site + carried - spent,
    dayToDay: spent - fixedTotal,
    peopleTotal,
    bankTotal,
    weekend,
    weekday: spent - weekend,
    count: transactions.length,
    categories: byCategory,
    people: [...personMap.values()].sort((a, b) => b.total - a.total),
    insights,
    transactions,
    fixedTemplates: await listFixedTemplates(userId),
  };
}

app.get("/api/health", async (_req, res, next) => {
  try {
    await pool.query("select 1");
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/session", async (req, res, next) => {
  try {
    const authUser = await requireAuthUser(req);
    const user = await getUserByAuthId(authUser.id);
    res.set("Cache-Control", "private, no-store");
    res.json({
      auth: mapAuthUser(authUser),
      user,
      needsSetup: !user,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/users", async (req, res, next) => {
  try {
    const authUser = await requireAuthUser(req);
    const user = await getUserByAuthId(authUser.id);
    res.set("Cache-Control", "private, no-store");
    res.json({ users: user ? [user] : [] });
  } catch (error) {
    next(error);
  }
});

app.get("/api/category-defaults", (_req, res) => {
  res.json({ categories: CATEGORIES });
});

app.post("/api/users", async (req, res, next) => {
  try {
    const authUser = await requireAuthUser(req);
    const existing = await getUserByAuthId(authUser.id);
    if (existing) {
      return res.status(400).json({ error: "Your ledger already exists." });
    }
    const name = String(req.body?.name || authUser.displayName || authUser.primaryEmail || "").trim().replace(/\s+/g, " ");
    const net = Number(String(req.body?.net ?? "").trim().replace(/\s/g, ""));
    if (!name || name.length > 40) {
      return res.status(400).json({ error: "Enter a name." });
    }
    if (!Number.isInteger(net) || net < 0 || net > 100_000_000) {
      return res.status(400).json({ error: "Enter the net as a whole number." });
    }
    const taken = await pool.query("select 1 from users where lower(name) = lower($1)", [name]);
    if (taken.rowCount) {
      return res.status(400).json({ error: "That name is already used." });
    }
    const setup = normalizeCategorySetup(req.body?.categories);
    let rows;
    try {
      ({ rows } = await pool.query(
        "insert into users (name, auth_id) values ($1, $2) returning id, name, auth_id",
        [name, authUser.id],
      ));
    } catch (error) {
      if (error.code === "23505") {
        return res.status(400).json({ error: "That name is already used." });
      }
      throw error;
    }
    const user = mapUser(rows[0]);
    await seedCategoriesForUser(user.id, setup);
    await ensureIncome(user.id, todayKey(), net);
    res.set("Cache-Control", "private, no-store");
    res.status(201).json({
      user,
      users: [user],
      ledger: await loadMonth(user.id),
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/users/me", async (req, res, next) => {
  try {
    const user = await resolveUserId(req);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("delete from transactions where user_id = $1", [user.id]);
      await client.query("delete from fixed_templates where user_id = $1", [user.id]);
      await client.query("delete from income where user_id = $1", [user.id]);
      await client.query("delete from categories where user_id = $1", [user.id]);
      await client.query("delete from users where id = $1", [user.id]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    res.set("Cache-Control", "private, no-store");
    res.json({ users: [] });
  } catch (error) {
    next(error);
  }
});

app.get("/api/bootstrap", async (req, res, next) => {
  try {
    const user = await resolveUserId(req);
    const summaries = await monthSummaries(user.id);
    const openMonth = summaries[0]?.month || todayKey();
    const requested = String(req.query.month || "").trim();
    await ensureFixedForMonth(user.id, openMonth);
    res.json(await loadMonth(user.id, requested || undefined));
  } catch (error) {
    next(error);
  }
});

app.get("/api/suggest", (req, res) => {
  const description = String(req.query.description || "");
  res.json({ category: categorize(description) });
});

app.post("/api/invoice-scan", async (req, res, next) => {
  try {
    await resolveUserId(req);
    const raw = req.body?.url || req.body?.qr || req.body?.text || "";
    const invoice = await resolveFiscalInvoice(raw);
    res.json({
      ...invoice,
      category: categorize(invoice.description),
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    next(error);
  }
});

app.post("/api/categories", async (req, res, next) => {
  try {
    const user = await resolveUserId(req);
    const name = cleanCategoryName(req.body?.name);
    if (!name) return res.status(400).json({ error: "Give the category a name." });
    const taken = await pool.query(
      "select 1 from categories where user_id = $1 and lower(name) = lower($2)",
      [user.id, name],
    );
    if (taken.rowCount) return res.status(400).json({ error: "That category already exists." });
    const slug = await uniqueSlug(user.id, slugify(name));
    const count = await pool.query(
      "select count(*)::int as n from categories where user_id = $1",
      [user.id],
    );
    const sort = await pool.query(
      "select coalesce(max(sort_order), 0) + 1 as next from categories where user_id = $1",
      [user.id],
    );
    await pool.query(
      `insert into categories (user_id, slug, name, color, sort_order) values ($1, $2, $3, $4, $5)`,
      [user.id, slug, name, NEW_COLORS[count.rows[0].n % NEW_COLORS.length], sort.rows[0].next],
    );
    res.status(201).json(await loadMonth(user.id, req.body?.month));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/categories/:slug", async (req, res, next) => {
  try {
    const user = await resolveUserId(req);
    const slug = String(req.params.slug);
    if (!await categoryExists(user.id, slug)) return res.status(404).json({ error: "That category is gone." });
    const name = cleanCategoryName(req.body?.name);
    if (!name) return res.status(400).json({ error: "Give the category a name." });
    const taken = await pool.query(
      "select 1 from categories where user_id = $1 and lower(name) = lower($2) and slug <> $3",
      [user.id, name, slug],
    );
    if (taken.rowCount) return res.status(400).json({ error: "That category already exists." });
    await pool.query(
      "update categories set name = $1 where user_id = $2 and slug = $3",
      [name, user.id, slug],
    );
    res.json(await loadMonth(user.id, req.body?.month));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/categories/:slug", async (req, res, next) => {
  try {
    const user = await resolveUserId(req);
    const slug = String(req.params.slug);
    if (!await categoryExists(user.id, slug)) {
      return res.status(404).json({ error: "That category is gone." });
    }
    if (slug === "other") {
      return res.status(400).json({ error: "Other stays — it’s the catch-all category." });
    }
    const count = await pool.query(
      "select count(*)::int as n from categories where user_id = $1",
      [user.id],
    );
    if ((count.rows[0]?.n || 0) <= 1) {
      return res.status(400).json({ error: "Keep at least one category." });
    }
    const [txUsage, fixedUsage] = await Promise.all([
      pool.query(
        "select count(*)::int as n from transactions where user_id = $1 and category_slug = $2",
        [user.id, slug],
      ),
      pool.query(
        "select count(*)::int as n from fixed_templates where user_id = $1 and category_slug = $2",
        [user.id, slug],
      ),
    ]);
    const records =
      (txUsage.rows[0]?.n || 0) + (fixedUsage.rows[0]?.n || 0);
    if (records > 0) {
      return res.status(400).json({
        error:
          "That category still has records. Move or delete them first.",
      });
    }
    await pool.query(
      "delete from categories where user_id = $1 and slug = $2",
      [user.id, slug],
    );
    res.json(await loadMonth(user.id, req.body?.month || req.query?.month));
  } catch (error) {
    next(error);
  }
});

app.post("/api/months", async (req, res, next) => {
  try {
    const user = await resolveUserId(req);
    const summaries = await monthSummaries(user.id);
    const latest = summaries[0] || null;
    const key = resolveNextMonth(latest, Boolean(req.body?.force));
    if (!latest || key !== latest.month) await ensureIncome(user.id, key);
    await ensureFixedForMonth(user.id, key);
    res.status(201).json(await loadMonth(user.id, key));
  } catch (error) {
    next(error);
  }
});

app.get("/api/fixed-templates", async (req, res, next) => {
  try {
    const user = await resolveUserId(req);
    res.json({ templates: await listFixedTemplates(user.id) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/fixed-templates", async (req, res, next) => {
  try {
    const user = await resolveUserId(req);
    const amount = parseAmountInput(req.body?.amount);
    const category = String(req.body?.category || "");
    const dayOfMonth = Number(req.body?.dayOfMonth);
    let description = String(req.body?.description || "").trim().replace(/\s+/g, " ");
    if (!amount || !await categoryExists(user.id, category)) {
      return res.status(400).json({ error: "Amount and category are required." });
    }
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
      return res.status(400).json({ error: "Pick a day of the month from 1 to 31." });
    }
    if (!description) {
      const named = await pool.query(
        "select name from categories where user_id = $1 and slug = $2",
        [user.id, category],
      );
      description = named.rows[0]?.name || "Fixed";
    }
    if (description.length > 180) {
      return res.status(400).json({ error: "Write a shorter note." });
    }
    const { rows: orderRows } = await pool.query(
      "select coalesce(max(sort_order), 0) + 1 as next from fixed_templates where user_id = $1",
      [user.id],
    );
    const { rows } = await pool.query(
      `insert into fixed_templates
        (user_id, amount, description, category_slug, day_of_month, active, sort_order)
       values ($1, $2, $3, $4, $5, true, $6)
       returning id, amount, description, category_slug, day_of_month, active`,
      [user.id, amount, description, category, dayOfMonth, orderRows[0].next],
    );
    const summaries = await monthSummaries(user.id);
    const openMonth = summaries[0]?.month || todayKey();
    await ensureIncome(user.id, openMonth);
    await ensureFixedForMonth(user.id, openMonth);
    res.status(201).json({
      template: mapFixedTemplate(rows[0]),
      templates: await listFixedTemplates(user.id),
      ledger: await loadMonth(user.id, openMonth),
    });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/fixed-templates/:id", async (req, res, next) => {
  try {
    const user = await resolveUserId(req);
    const id = Number(req.params.id);
    const current = await pool.query(
      `select id, amount, description, category_slug, day_of_month, active
       from fixed_templates where id = $1 and user_id = $2`,
      [id, user.id],
    );
    if (!current.rows[0]) {
      return res.status(404).json({ error: "That fixed payment is gone." });
    }

    const fields = [];
    const values = [];
    const set = (column, value) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };

    if (req.body?.amount != null) {
      const amount = parseAmountInput(req.body.amount);
      if (!amount) return res.status(400).json({ error: "Enter the amount as a whole number." });
      set("amount", amount);
    }
    if (req.body?.description != null) {
      const description = String(req.body.description).trim().replace(/\s+/g, " ");
      if (!description || description.length > 180) {
        return res.status(400).json({ error: "Write what the money was for." });
      }
      set("description", description);
    }
    if (req.body?.category != null) {
      const category = String(req.body.category);
      if (!await categoryExists(user.id, category)) {
        return res.status(400).json({ error: "That category does not exist." });
      }
      set("category_slug", category);
    }
    if (req.body?.dayOfMonth != null) {
      const dayOfMonth = Number(req.body.dayOfMonth);
      if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
        return res.status(400).json({ error: "Pick a day of the month from 1 to 31." });
      }
      set("day_of_month", dayOfMonth);
    }
    if (req.body?.active != null) {
      set("active", Boolean(req.body.active));
    }

    if (fields.length) {
      values.push(id);
      values.push(user.id);
      await pool.query(
        `update fixed_templates set ${fields.join(", ")}
         where id = $${values.length - 1} and user_id = $${values.length}`,
        values,
      );
    }

    const updated = await pool.query(
      `select id, amount, description, category_slug, day_of_month, active
       from fixed_templates where id = $1 and user_id = $2`,
      [id, user.id],
    );
    const template = mapFixedTemplate(updated.rows[0]);
    const summaries = await monthSummaries(user.id);
    const openMonth = summaries[0]?.month || todayKey();

    if (template.active) {
      const openBounds = monthBounds(openMonth);
      const existing = await pool.query(
        `select id from transactions
         where user_id = $1 and fixed_template_id = $2
           and spent_on >= $3::date and spent_on < $4::date
         limit 1`,
        [user.id, id, openBounds.start, openBounds.next],
      );
      if (existing.rows[0]) {
        const spentOn = spentOnForTemplate(openMonth, template.dayOfMonth);
        await pool.query(
          `update transactions
           set amount = $1,
               description = $2,
               category_slug = $3,
               spent_on = $4,
               weekend = $5,
               fixed = true
           where id = $6 and user_id = $7`,
          [
            template.amount,
            template.description,
            template.category,
            spentOn,
            isWeekendIso(spentOn),
            existing.rows[0].id,
            user.id,
          ],
        );
      } else {
        await ensureFixedForMonth(user.id, openMonth);
      }
    }

    res.json({
      template,
      templates: await listFixedTemplates(user.id),
      ledger: await loadMonth(user.id, openMonth),
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/fixed-templates/:id", async (req, res, next) => {
  try {
    const user = await resolveUserId(req);
    const id = Number(req.params.id);
    const current = await pool.query(
      "select id from fixed_templates where id = $1 and user_id = $2",
      [id, user.id],
    );
    if (!current.rows[0]) {
      return res.status(404).json({ error: "That fixed payment is gone." });
    }
    await pool.query("delete from fixed_templates where id = $1 and user_id = $2", [
      id,
      user.id,
    ]);
    const summaries = await monthSummaries(user.id);
    const openMonth = summaries[0]?.month || todayKey();
    res.json({
      templates: await listFixedTemplates(user.id),
      ledger: await loadMonth(user.id, openMonth),
    });
  } catch (error) {
    next(error);
  }
});

app.put("/api/income", async (req, res, next) => {
  try {
    const user = await resolveUserId(req);
    const bounds = monthBounds(req.body?.month);
    if (!bounds) {
      return res.status(400).json({ error: "Enter the net as a whole number." });
    }

    const hasAmount = req.body?.amount != null;
    const hasSite = req.body?.site != null;
    if (!hasAmount && !hasSite) {
      return res.status(400).json({ error: "Enter the net as a whole number." });
    }

    const amount = hasAmount
      ? Number(String(req.body.amount).trim().replace(/\s/g, ""))
      : null;
    const site = hasSite
      ? Number(String(req.body.site).trim().replace(/\s/g, ""))
      : null;

    if (hasAmount && (!Number.isInteger(amount) || amount < 0 || amount > 100_000_000)) {
      return res.status(400).json({ error: "Enter the net as a whole number." });
    }
    if (hasSite && (!Number.isInteger(site) || site < 0 || site > 100_000_000)) {
      return res.status(400).json({ error: "Enter the site money as a whole number." });
    }

    const existing = await pool.query(
      "select amount, site_amount from income where user_id = $1 and month = $2",
      [user.id, bounds.start],
    );
    const nextAmount = hasAmount ? amount : (existing.rows[0]?.amount ?? 0);
    const nextSite = hasSite ? site : (existing.rows[0]?.site_amount ?? 0);

    await pool.query(
      `insert into income (user_id, month, amount, site_amount) values ($1, $2, $3, $4)
       on conflict (user_id, month) do update
       set amount = excluded.amount,
           site_amount = excluded.site_amount`,
      [user.id, bounds.start, nextAmount, nextSite],
    );
    res.json(await loadMonth(user.id, bounds.key));
  } catch (error) {
    next(error);
  }
});

app.get("/api/transactions/search", async (req, res, next) => {
  try {
    const user = await resolveUserId(req);
    const q = String(req.query?.q || "").trim();
    const category = String(req.query?.category || "").trim();
    const month = String(req.query?.month || "").trim();
    const day = String(req.query?.day || "").trim().toLowerCase();
    const bounds = month ? monthBounds(month) : null;
    if (month && !bounds) {
      return res.status(400).json({ error: "That month is not valid." });
    }
    if (day && day !== "weekday" && day !== "weekend") {
      return res.status(400).json({ error: "Day filter must be weekday or weekend." });
    }
    if (!q && !category && !month && !day) {
      return res.json({ transactions: [] });
    }
    if (q.length > 80) {
      return res.status(400).json({ error: "Search is too long." });
    }
    if (category && !(await categoryExists(user.id, category))) {
      return res.status(400).json({ error: "That category was not found." });
    }
    const pattern = q ? `%${q.replace(/[%_\\]/g, "\\$&")}%` : "";
    const digits = q.replace(/\D/g, "");
    const weekendFilter =
      day === "weekend" ? true : day === "weekday" ? false : null;
    const { rows } = await pool.query(
      `select id, amount, description, category_slug, people,
              to_char(spent_on, 'YYYY-MM-DD') as spent_on,
              weekend, fixed, fixed_template_id
       from transactions
       where user_id = $1
         and ($4 = '' or category_slug = $4)
         and ($5::date is null or (spent_on >= $5::date and spent_on < $6::date))
         and ($7::boolean is null or weekend = $7::boolean)
         and (
           $2 = ''
           or description ilike $2 escape '\\'
           or exists (
             select 1 from unnest(people) as person
             where person ilike $2 escape '\\'
           )
           or ($3 <> '' and amount::text like $3)
           or ($3 <> '' and to_char(amount, 'FM999999999') like $3)
         )
       order by spent_on desc, sort_order desc, id desc
       limit 120`,
      [
        user.id,
        pattern,
        digits ? `%${digits}%` : "",
        category,
        bounds?.start || null,
        bounds?.next || null,
        weekendFilter,
      ],
    );
    res.json({ transactions: rows.map(mapTx) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/transactions", async (req, res, next) => {
  try {
    const user = await resolveUserId(req);
    const amount = parseAmountInput(req.body?.amount);
    const description = String(req.body?.description || "").trim().replace(/\s+/g, " ");
    const category = String(req.body?.category || "");
    const spentOn = String(req.body?.spentOn || "");
    if (!amount || !description || description.length > 180 || !await categoryExists(user.id, category) || !/^\d{4}-\d{2}-\d{2}$/.test(spentOn)) {
      return res.status(400).json({ error: "Amount, note, category, and date are required." });
    }
    const summaries = await monthSummaries(user.id);
    const openMonth = summaries[0]?.month || null;
    const pastMonth = summaries.find((item) => item.month !== openMonth)?.month || null;
    const targetMonth = spentOn.slice(0, 7);
    if (openMonth && targetMonth < openMonth && targetMonth !== pastMonth) {
      return res.status(400).json({ error: "You can add a line to this month or the past month." });
    }
    const { rows } = await pool.query(
      "select coalesce(max(sort_order), 0) + 1 as next from transactions where user_id = $1",
      [user.id],
    );
    await ensureIncome(user.id, spentOn.slice(0, 7));
    const isFixed = Boolean(req.body?.fixed);
    let fixedTemplateId = null;
    if (isFixed) {
      const dayOfMonth = Math.min(
        31,
        Math.max(1, Number(spentOn.slice(-2)) || 1),
      );
      fixedTemplateId = await createFixedTemplateRow(user.id, {
        amount,
        description,
        category,
        dayOfMonth,
      });
    }
    await pool.query(
      `insert into transactions
        (user_id, amount, description, category_slug, people, spent_on, weekend, sort_order, fixed, fixed_template_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        user.id,
        amount,
        description,
        category,
        [],
        spentOn,
        isWeekendIso(spentOn),
        rows[0].next,
        isFixed,
        fixedTemplateId,
      ],
    );
    res.status(201).json(await loadMonth(user.id, spentOn.slice(0, 7)));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/transactions/:id", async (req, res, next) => {
  try {
    const user = await resolveUserId(req);
    const id = Number(req.params.id);
    const current = await pool.query(
      `select amount, description, category_slug,
              to_char(spent_on, 'YYYY-MM-DD') as spent_on,
              fixed, fixed_template_id
       from transactions where id = $1 and user_id = $2`,
      [id, user.id],
    );
    if (!current.rows[0]) return res.status(404).json({ error: "That line is gone." });
    const row = current.rows[0];

    const fields = [];
    const values = [];
    const set = (column, value) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };

    if (req.body?.amount != null) {
      const amount = parseAmountInput(req.body.amount);
      if (!amount) return res.status(400).json({ error: "Enter the amount as a whole number." });
      set("amount", amount);
    }
    if (req.body?.description != null) {
      const description = String(req.body.description).trim().replace(/\s+/g, " ");
      if (!description || description.length > 180) {
        return res.status(400).json({ error: "Write what the money was for." });
      }
      set("description", description);
    }
    if (req.body?.category != null) {
      const category = String(req.body.category);
      if (!await categoryExists(user.id, category)) return res.status(400).json({ error: "That category does not exist." });
      set("category_slug", category);
    }
    if (req.body?.spentOn != null) {
      const spentOn = String(req.body.spentOn);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn)) return res.status(400).json({ error: "That date is not valid." });
      set("spent_on", spentOn);
      set("weekend", isWeekendIso(spentOn));
    }
    if (req.body?.fixed != null) {
      const nextFixed = Boolean(req.body.fixed);
      set("fixed", nextFixed);
      if (nextFixed && !row.fixed_template_id) {
        const spentOn = String(req.body?.spentOn || row.spent_on);
        const amount = req.body?.amount != null
          ? parseAmountInput(req.body.amount)
          : row.amount;
        const description = req.body?.description != null
          ? String(req.body.description).trim().replace(/\s+/g, " ")
          : row.description;
        const category = req.body?.category != null
          ? String(req.body.category)
          : row.category_slug;
        const dayOfMonth = Math.min(
          31,
          Math.max(1, Number(spentOn.slice(-2)) || 1),
        );
        const templateId = await createFixedTemplateRow(user.id, {
          amount,
          description,
          category,
          dayOfMonth,
        });
        set("fixed_template_id", templateId);
      }
    }

    if (fields.length) {
      values.push(id);
      values.push(user.id);
      await pool.query(
        `update transactions set ${fields.join(", ")} where id = $${values.length - 1} and user_id = $${values.length}`,
        values,
      );
    }

    const monthSource = req.body?.spentOn || row.spent_on;
    res.json(await loadMonth(user.id, String(monthSource).slice(0, 7)));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/transactions/:id", async (req, res, next) => {
  try {
    const user = await resolveUserId(req);
    const id = Number(req.params.id);
    const current = await pool.query(
      "select to_char(spent_on, 'YYYY-MM') as month from transactions where id = $1 and user_id = $2",
      [id, user.id],
    );
    if (!current.rows[0]) return res.status(404).json({ error: "That line is gone." });
    await pool.query("delete from transactions where id = $1 and user_id = $2", [id, user.id]);
    res.json(await loadMonth(user.id, current.rows[0].month));
  } catch (error) {
    next(error);
  }
});

if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? "The ledger could not be updated." : error.message });
});

async function waitForDb() {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      await pool.query("select 1");
      return;
    } catch (error) {
      if (attempt === 30) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function main() {
  await waitForDb();
  await ensureSchema(pool);
  app.listen(port, host, () => {
    console.log(`API on http://${host}:${port}`);
  });
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
