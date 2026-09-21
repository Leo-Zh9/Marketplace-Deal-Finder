import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AuthGate } from "./auth/AuthGate";
import { shouldUseLocalDevelopmentIdentity } from "./auth/environment";
import { createFirebaseAdapter } from "./auth/firebaseAdapter";
import "./styles.css";

const mode = shouldUseLocalDevelopmentIdentity({
  dev: import.meta.env.DEV,
  hostname: window.location.hostname,
})
  ? "local-development"
  : "firebase";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate mode={mode} createAdapter={createFirebaseAdapter}>
      {(identity, onSignOut) => <App identity={identity} onSignOut={onSignOut} />}
    </AuthGate>
  </StrictMode>,
);
