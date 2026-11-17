import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AuthGate } from "./auth/AuthGate";
import { shouldUseLocalDevelopmentIdentity } from "./auth/environment";
import { captureLocalUser } from "./auth/localUser";
import { createFirebaseAdapter } from "./auth/firebaseAdapter";
import "./styles.css";

// Development only: `?as=<name>` signs this tab in as a second local user (src/auth/localUser.ts).
if (import.meta.env.DEV) captureLocalUser(window.location.search, window.sessionStorage);

const mode = shouldUseLocalDevelopmentIdentity({
  dev: import.meta.env.DEV,
  hostname: window.location.hostname,
})
  ? "local-development"
  : "firebase";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate mode={mode} createAdapter={createFirebaseAdapter}>
      {(identity, onSignOut, getToken) => (
        <App identity={identity} onSignOut={onSignOut} getToken={getToken} />
      )}
    </AuthGate>
  </StrictMode>,
);
