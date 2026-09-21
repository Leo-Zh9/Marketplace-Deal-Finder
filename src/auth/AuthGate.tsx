import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { requestJsonWithAuth } from "../services/apiClient";
import { resetMarketplaceState } from "../services/marketplaceClient";
import {
  ApiRequestError,
  type AuthAdapter,
  type AuthenticatedIdentity,
} from "./authTypes";

type GetToken = (forceRefresh: boolean) => Promise<string | null>;

export interface AuthGateProps {
  mode: "firebase" | "local-development";
  createAdapter: () => AuthAdapter;
  requestSession?: (getToken: GetToken) => Promise<{ identity: AuthenticatedIdentity }>;
  children: (
    identity: AuthenticatedIdentity,
    onSignOut: (() => void) | undefined,
  ) => ReactNode;
}

type AuthState =
  | { status: "initializing" }
  | { status: "signed-out"; message: string | null }
  | { status: "authorizing" }
  | { status: "approved"; identity: AuthenticatedIdentity }
  | { status: "denied"; message: string }
  | { status: "service-error"; message: string; retryable: boolean };

const SESSION_ENDED_MESSAGE = "Your session has ended. Sign in again.";
const POPUP_INTERRUPTED_MESSAGE = "Sign-in was interrupted. Try again.";
const DENIED_MESSAGE =
  "This Google account is not approved for access. Ask the owner to add it, or sign in with another account.";
const KEYS_UNAVAILABLE_MESSAGE = "Sign-in verification is temporarily unavailable.";
const SETUP_MESSAGE = "The application is not configured yet.";
const GENERIC_SERVICE_MESSAGE =
  "The application service is temporarily unavailable. Try again in a moment.";

const POPUP_ERROR_CODES = new Set([
  "auth/popup-blocked",
  "auth/popup-closed-by-user",
  "auth/cancelled-popup-request",
]);

const noToken: GetToken = async () => null;

const defaultRequestSession = (getToken: GetToken) =>
  requestJsonWithAuth<{ identity: AuthenticatedIdentity }>(
    "/api/auth/session",
    getToken,
  );

/** Keeps the render prop out of AuthGate's own render, where its refs live. */
const ApprovedShell = ({
  identity,
  onSignOut,
  render,
}: {
  identity: AuthenticatedIdentity;
  onSignOut: (() => void) | undefined;
  render: AuthGateProps["children"];
}) => <>{render(identity, onSignOut)}</>;

/** Copy and affordance come from the server's error code, not from the kind alone. */
const serviceErrorFor = (error: unknown): { message: string; retryable: boolean } => {
  const code = error instanceof ApiRequestError ? error.code : null;
  if (code === "AUTH_KEYS_UNAVAILABLE") {
    return { message: KEYS_UNAVAILABLE_MESSAGE, retryable: true };
  }
  if (code === "AUTH_CONFIG_MISSING" || code === "AUTH_CONFIG_INVALID") {
    // Retrying cannot help until a human fixes configuration.
    return { message: SETUP_MESSAGE, retryable: false };
  }
  return { message: GENERIC_SERVICE_MESSAGE, retryable: true };
};

export const AuthGate = ({
  mode,
  createAdapter,
  requestSession = defaultRequestSession,
  children,
}: AuthGateProps) => {
  const [state, setState] = useState<AuthState>({ status: "initializing" });
  // Built once, during render, so a construction failure is a render outcome
  // rather than a setState from inside an effect.
  const [adapter] = useState<AuthAdapter | null>(() => {
    if (mode !== "firebase") return null;
    try {
      return createAdapter();
    } catch {
      return null;
    }
  });
  const generationRef = useRef(0);
  const uidRef = useRef<string | null | undefined>(undefined);

  const loadSession = useCallback(
    async (generation: number, getToken: GetToken, background: boolean) => {
      try {
        const { identity } = await requestSession(getToken);
        if (generation !== generationRef.current) return;

        if (
          mode === "local-development" &&
          identity.authenticationMethod !== "local-development"
        ) {
          setState({ status: "service-error", message: SETUP_MESSAGE, retryable: false });
          return;
        }

        setState({ status: "approved", identity });
      } catch (error) {
        if (generation !== generationRef.current) return;

        const kind = error instanceof ApiRequestError ? error.kind : "unexpected";

        if (kind === "forbidden") {
          // Revoked access must evict immediately, background or not.
          setState({ status: "denied", message: DENIED_MESSAGE });
          return;
        }

        if (kind === "unauthenticated") {
          // The single forced refresh is already spent, so the token is dead.
          setState({ status: "signed-out", message: SESSION_ENDED_MESSAGE });
          return;
        }

        // A transient blip must not destroy a mounted dashboard: the Worker
        // authenticates every later call, so staying mounted grants nothing.
        if (background) return;

        setState({ status: "service-error", ...serviceErrorFor(error) });
      }
    },
    [mode, requestSession],
  );

  useEffect(() => {
    if (mode !== "local-development") return;

    generationRef.current += 1;
    void loadSession(generationRef.current, noToken, false);
  }, [mode, loadSession]);

  useEffect(() => {
    if (adapter === null) return;

    const unsubscribe = adapter.subscribe((user) => {
      const nextUid = user?.uid ?? null;

      if (nextUid !== uidRef.current) {
        // Sign-in, sign-out, or account change.
        generationRef.current += 1;
        uidRef.current = nextUid;
        resetMarketplaceState();

        if (nextUid === null) {
          setState({ status: "signed-out", message: null });
          return;
        }

        setState({ status: "authorizing" });
        void loadSession(generationRef.current, adapter.getToken, false);
        return;
      }

      // A routine hourly ID-token refresh: re-check the Worker without
      // remounting App or destroying any Phase 1 state.
      void loadSession(generationRef.current, adapter.getToken, true);
    });

    return () => {
      unsubscribe();
    };
  }, [adapter, loadSession]);

  const signIn = useCallback(async () => {
    if (adapter === null) return;

    setState({ status: "authorizing" });
    try {
      await adapter.signIn();
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === "string" && POPUP_ERROR_CODES.has(code)) {
        setState({ status: "signed-out", message: POPUP_INTERRUPTED_MESSAGE });
        return;
      }
      setState({
        status: "service-error",
        message: GENERIC_SERVICE_MESSAGE,
        retryable: true,
      });
    }
  }, [adapter]);

  const signOut = useCallback(() => {
    generationRef.current += 1;
    // `undefined` means "no event seen", not "signed out". Firebase's signOut()
    // notifies id-token listeners with null; parking on `null` here would make
    // that notification look like a routine token refresh, firing a tokenless
    // session request whose 401 would replace this clean panel with an expiry
    // warning. The same reasoning is why the ref starts `undefined` on a cold
    // load, where the first event is also `null`.
    uidRef.current = undefined;
    resetMarketplaceState();
    setState({ status: "signed-out", message: null });
    void adapter?.signOut();
  }, [adapter]);

  const retry = useCallback(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const getToken = adapter === null ? noToken : adapter.getToken;

    setState({ status: "authorizing" });
    void loadSession(generation, getToken, false);
  }, [adapter, loadSession]);

  // Missing public configuration can never fall back to a local identity.
  const effectiveState: AuthState =
    mode === "firebase" && adapter === null
      ? { status: "service-error", message: SETUP_MESSAGE, retryable: false }
      : state;

  if (
    effectiveState.status === "initializing" ||
    effectiveState.status === "authorizing"
  ) {
    return (
      <div className="auth-gate">
        <div className="loading-state">
          <span className="spinner" aria-hidden="true" />
          <strong>Checking your access…</strong>
          <p>One moment while your Google account is confirmed.</p>
        </div>
      </div>
    );
  }

  if (effectiveState.status === "signed-out") {
    return (
      <div className="auth-gate">
        <h1>Marketplace Deal Finder</h1>
        <p>Sign in with an approved Google account to open the dashboard.</p>
        {effectiveState.message !== null && (
          <p className="error-banner" role="alert">
            {effectiveState.message}
          </p>
        )}
        <button type="button" className="primary-button" onClick={() => void signIn()}>
          Sign in with Google
        </button>
      </div>
    );
  }

  if (effectiveState.status === "denied") {
    return (
      <div className="auth-gate">
        <h1>Access denied</h1>
        <p className="error-banner" role="alert">
          {effectiveState.message}
        </p>
        <button type="button" className="secondary-button" onClick={signOut}>
          Sign out and use another account
        </button>
      </div>
    );
  }

  if (effectiveState.status === "service-error") {
    return (
      <div className="auth-gate">
        <h1>Marketplace Deal Finder</h1>
        <p className="error-banner" role="alert">
          {effectiveState.message}
        </p>
        {effectiveState.retryable && (
          <button type="button" className="primary-button" onClick={retry}>
            Try again
          </button>
        )}
      </div>
    );
  }

  return (
    <ApprovedShell
      identity={effectiveState.identity}
      onSignOut={adapter === null ? undefined : signOut}
      render={children}
    />
  );
};
