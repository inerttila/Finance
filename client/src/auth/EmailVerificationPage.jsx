import { EmailVerification } from "@hexclave/react";

export default function EmailVerificationPage() {
  const searchParams = Object.fromEntries(
    new URLSearchParams(window.location.search).entries(),
  );

  return (
    <div className="auth-page">
      <img
        className="auth-gate-logo"
        src="/net-mark.svg"
        width="104"
        height="78"
        alt="Net"
      />
      <div className="auth-page-panel">
        <EmailVerification fullPage searchParams={searchParams} />
      </div>
    </div>
  );
}
