import { useEffect, useState } from "react";
import { useHexclaveApp, useUser } from "@hexclave/react";

export default function OnboardingPage() {
  const app = useHexclaveApp();
  const user = useUser({ or: "return-null", includeRestricted: true });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user || user.isAnonymous) {
      void app.redirectToSignIn();
      return;
    }
    if (!user.isRestricted) {
      void app.redirectToAfterSignIn();
    }
  }, [app, user]);

  if (!user || user.isAnonymous || !user.isRestricted) {
    return (
      <div className="auth-page auth-page-loading" aria-busy="true">
        <p className="hint">One moment…</p>
      </div>
    );
  }

  const email = user.primaryEmail || "your inbox";

  async function resend() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await user.sendVerificationEmail();
      setNotice("Verification email sent again. Check your inbox.");
    } catch (err) {
      setError(err?.message || "Could not resend the email.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      await user.signOut();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <img
        className="auth-gate-logo"
        src="/net-mark.svg"
        width="104"
        height="78"
        alt="Net"
      />
      <div className="auth-page-panel auth-verify-panel">
        <p className="eyebrow">Almost there</p>
        <h1 className="auth-verify-title">Check your email</h1>
        <p className="hint auth-verify-copy">
          We sent a verification link to <strong>{email}</strong>. Open it to
          finish creating your account.
        </p>
        {notice ? (
          <p className="auth-verify-notice" role="status">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="banner" role="alert">
            {error}
          </p>
        ) : null}
        <div className="editor-actions auth-gate-actions">
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={resend}
          >
            {busy ? "Sending…" : "Resend email"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={signOut}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
