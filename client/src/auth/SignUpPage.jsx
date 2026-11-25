import { SignUp } from "@hexclave/react";

export default function SignUpPage() {
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
        <SignUp fullPage automaticRedirect />
      </div>
    </div>
  );
}
