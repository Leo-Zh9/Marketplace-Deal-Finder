import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, type ReactNode } from "react";
import { resetMarketplaceState } from "../services/marketplaceClient";
import { AuthGate } from "./AuthGate";
import {
  ApiRequestError,
  FirebaseConfigError,
  type AuthAdapter,
  type AuthenticatedIdentity,
  type AuthUser,
} from "./authTypes";

// The Firebase SDK is never imported here: only firebaseAdapter.ts imports it,
// and only main.tsx imports firebaseAdapter.
vi.mock("../services/marketplaceClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/marketplaceClient")>();
  return { ...actual, resetMarketplaceState: vi.fn() };
});

const firebaseIdentity: AuthenticatedIdentity = {
  email: "owner@example.com",
  subject: "firebase-uid-1",
  expiresAt: 1_800_003_600,
  authenticationMethod: "firebase-google",
};

const localIdentity: AuthenticatedIdentity = {
  email: "local-dev@localhost",
  subject: "local-development",
  expiresAt: 1_800_086_400,
  authenticationMethod: "local-development",
};

interface FakeAdapter extends AuthAdapter {
  emit(user: AuthUser | null): void;
}

// Models the Firebase contract, not the gate's assumptions: signOut() notifies
// id-token listeners with null, and getToken() resolves null once there is no
// current user.
const createFakeAdapter = (
  overrides: Partial<AuthAdapter> = {},
): FakeAdapter => {
  let listener: ((user: AuthUser | null) => void) | null = null;
  let currentUser: AuthUser | null = null;

  return {
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    signIn: () => Promise.resolve(),
    signOut: () => {
      currentUser = null;
      listener?.(null);
      return Promise.resolve();
    },
    getToken: () => Promise.resolve(currentUser === null ? null : "id-token"),
    emit: (user) => {
      currentUser = user;
      listener?.(user);
    },
    ...overrides,
  };
};

let mountCount = 0;

const Dashboard = ({ label = "dashboard" }: { label?: string }) => {
  useEffect(() => {
    mountCount += 1;
  }, []);
  return <div>{label}</div>;
};

const emit = async (adapter: FakeAdapter, user: AuthUser | null) => {
  await act(async () => {
    adapter.emit(user);
  });
};

const renderGate = (props: {
  mode: "firebase" | "local-development";
  createAdapter?: () => AuthAdapter;
  requestSession?: (
    getToken: (forceRefresh: boolean) => Promise<string | null>,
  ) => Promise<{ identity: AuthenticatedIdentity }>;
  children?: (
    identity: AuthenticatedIdentity,
    onSignOut: (() => void) | undefined,
  ) => ReactNode;
}) =>
  render(
    <AuthGate
      mode={props.mode}
      createAdapter={props.createAdapter ?? (() => createFakeAdapter())}
      requestSession={props.requestSession ?? (() => Promise.resolve({ identity: firebaseIdentity }))}
    >
      {props.children ?? (() => <Dashboard />)}
    </AuthGate>,
  );

beforeEach(() => {
  mountCount = 0;
  vi.mocked(resetMarketplaceState).mockClear();
});

describe("authentication gate", () => {
  it("never renders the dashboard before the Worker approves", async () => {
    const adapter = createFakeAdapter();
    renderGate({ mode: "firebase", createAdapter: () => adapter });

    expect(screen.queryByText("dashboard")).not.toBeInTheDocument();

    await emit(adapter, null);
    expect(
      await screen.findByRole("button", { name: "Sign in with Google" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("dashboard")).not.toBeInTheDocument();
  });

  it("keeps a blocked popup retryable", async () => {
    const user = userEvent.setup();
    const signIn = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("blocked"), { code: "auth/popup-blocked" }));
    const adapter = createFakeAdapter({ signIn });
    renderGate({ mode: "firebase", createAdapter: () => adapter });
    await emit(adapter, null);

    const button = await screen.findByRole("button", { name: "Sign in with Google" });
    await user.click(button);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sign-in was interrupted. Try again.",
    );
    await user.click(screen.getByRole("button", { name: "Sign in with Google" }));
    expect(signIn).toHaveBeenCalledTimes(2);
  });

  it("renders the dashboard with the approved identity", async () => {
    const adapter = createFakeAdapter();
    const received: AuthenticatedIdentity[] = [];
    renderGate({
      mode: "firebase",
      createAdapter: () => adapter,
      children: (identity) => {
        received.push(identity);
        return <Dashboard />;
      },
    });
    await emit(adapter, { uid: "a", email: "owner@example.com" });

    expect(await screen.findByText("dashboard")).toBeInTheDocument();
    expect(received).toContainEqual(firebaseIdentity);
  });

  it("evicts a forbidden identity and offers another account", async () => {
    const adapter = createFakeAdapter();
    renderGate({
      mode: "firebase",
      createAdapter: () => adapter,
      requestSession: () =>
        Promise.reject(new ApiRequestError("denied", "forbidden", 403, "AUTH_FORBIDDEN")),
    });
    await emit(adapter, { uid: "a", email: "stranger@example.com" });

    expect(await screen.findByRole("alert")).toHaveTextContent("not approved for access");
    expect(
      screen.getByRole("button", { name: "Sign out and use another account" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("dashboard")).not.toBeInTheDocument();
  });

  it("keeps a service failure distinct from a provider outage and allows a retry", async () => {
    const user = userEvent.setup();
    const adapter = createFakeAdapter();
    const requestSession = vi
      .fn()
      .mockRejectedValueOnce(new ApiRequestError("offline", "network"))
      .mockResolvedValue({ identity: firebaseIdentity });
    renderGate({ mode: "firebase", createAdapter: () => adapter, requestSession });
    await emit(adapter, { uid: "a", email: "owner@example.com" });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("application service is temporarily unavailable");
    expect(alert).not.toHaveTextContent(/facebook/i);
    expect(screen.queryByText("dashboard")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("dashboard")).toBeInTheDocument();
    expect(requestSession).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["AUTH_KEYS_UNAVAILABLE", "Sign-in verification is temporarily unavailable.", true],
    ["AUTH_CONFIG_MISSING", "The application is not configured yet.", false],
  ])("branches service copy on the %s code", async (code, copy, retryable) => {
    const adapter = createFakeAdapter();
    renderGate({
      mode: "firebase",
      createAdapter: () => adapter,
      requestSession: () =>
        Promise.reject(new ApiRequestError("service", "server", 503, code)),
    });
    await emit(adapter, { uid: "a", email: "owner@example.com" });

    expect(await screen.findByRole("alert")).toHaveTextContent(copy);
    expect(screen.queryByRole("button", { name: "Try again" }) !== null).toBe(retryable);
  });

  it("never reopens the app for an identity the user has signed out of", async () => {
    const user = userEvent.setup();
    const adapter = createFakeAdapter();
    let release!: (value: { identity: AuthenticatedIdentity }) => void;
    const requestSession = vi
      .fn()
      .mockResolvedValueOnce({ identity: firebaseIdentity })
      .mockImplementationOnce(
        () =>
          new Promise<{ identity: AuthenticatedIdentity }>((resolve) => {
            release = resolve;
          }),
      );

    renderGate({
      mode: "firebase",
      createAdapter: () => adapter,
      requestSession,
      children: (_identity, onSignOut) => (
        <div>
          <span>dashboard</span>
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      ),
    });

    await emit(adapter, { uid: "a", email: "owner@example.com" });
    expect(await screen.findByText("dashboard")).toBeInTheDocument();

    // A background re-check is in flight when the user signs out.
    await emit(adapter, { uid: "a", email: "owner@example.com" });
    await waitFor(() => {
      expect(requestSession).toHaveBeenCalledTimes(2);
    });
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("button", { name: "Sign in with Google" });

    await act(async () => {
      release({ identity: firebaseIdentity });
    });

    expect(screen.queryByText("dashboard")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign in with Google" }),
    ).toBeInTheDocument();
  });

  it("returns to a clean sign-in panel after a deliberate sign-out", async () => {
    const user = userEvent.setup();
    const adapter = createFakeAdapter();
    // The Worker's contract: no token means 401, not a session.
    const requestSession = vi.fn(
      async (getToken: (forceRefresh: boolean) => Promise<string | null>) => {
        if ((await getToken(false)) === null) {
          throw new ApiRequestError("missing", "unauthenticated", 401, "AUTH_TOKEN_MISSING");
        }
        return { identity: firebaseIdentity };
      },
    );

    renderGate({
      mode: "firebase",
      createAdapter: () => adapter,
      requestSession,
      children: (_identity, onSignOut) => (
        <div>
          <span>dashboard</span>
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      ),
    });

    await emit(adapter, { uid: "a", email: "owner@example.com" });
    expect(await screen.findByText("dashboard")).toBeInTheDocument();
    const callsWhileSignedIn = requestSession.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(
      await screen.findByRole("button", { name: "Sign in with Google" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("dashboard")).not.toBeInTheDocument();
    // A deliberate sign-out is not an expiry: no warning, and no tokenless
    // round trip to the Worker.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(requestSession).toHaveBeenCalledTimes(callsWhileSignedIn);
  });

  it("resets prototype state on an account switch and shows only the new identity", async () => {
    const adapter = createFakeAdapter();
    const identities = [
      { ...firebaseIdentity, email: "a@example.com", subject: "uid-a" },
      { ...firebaseIdentity, email: "b@example.com", subject: "uid-b" },
    ];
    const requestSession = vi
      .fn()
      .mockResolvedValueOnce({ identity: identities[0] })
      .mockResolvedValueOnce({ identity: identities[1] });

    renderGate({
      mode: "firebase",
      createAdapter: () => adapter,
      requestSession,
      children: (identity) => <div>{identity.email}</div>,
    });

    await emit(adapter, { uid: "a", email: "a@example.com" });
    expect(await screen.findByText("a@example.com")).toBeInTheDocument();

    const resetsAfterFirstSignIn = vi.mocked(resetMarketplaceState).mock.calls.length;
    await emit(adapter, { uid: "b", email: "b@example.com" });
    expect(await screen.findByText("b@example.com")).toBeInTheDocument();
    expect(screen.queryByText("a@example.com")).not.toBeInTheDocument();
    expect(vi.mocked(resetMarketplaceState).mock.calls.length).toBeGreaterThan(
      resetsAfterFirstSignIn,
    );
  });

  it("re-checks the Worker on a routine token refresh without remounting", async () => {
    const adapter = createFakeAdapter();
    const requestSession = vi.fn().mockResolvedValue({ identity: firebaseIdentity });
    renderGate({ mode: "firebase", createAdapter: () => adapter, requestSession });

    await emit(adapter, { uid: "a", email: "owner@example.com" });
    expect(await screen.findByText("dashboard")).toBeInTheDocument();

    const mountsAfterSignIn = mountCount;
    const resetsAfterSignIn = vi.mocked(resetMarketplaceState).mock.calls.length;

    await emit(adapter, { uid: "a", email: "owner@example.com" });
    await waitFor(() => {
      expect(requestSession).toHaveBeenCalledTimes(2);
    });

    expect(screen.getByText("dashboard")).toBeInTheDocument();
    expect(screen.queryByText("Checking your access…")).not.toBeInTheDocument();
    expect(mountCount).toBe(mountsAfterSignIn);
    expect(vi.mocked(resetMarketplaceState).mock.calls.length).toBe(resetsAfterSignIn);
  });

  it("keeps the dashboard mounted through a transient background failure", async () => {
    const adapter = createFakeAdapter();
    const requestSession = vi
      .fn()
      .mockResolvedValueOnce({ identity: firebaseIdentity })
      .mockRejectedValueOnce(new ApiRequestError("blip", "server", 500, null));
    renderGate({ mode: "firebase", createAdapter: () => adapter, requestSession });

    await emit(adapter, { uid: "a", email: "owner@example.com" });
    expect(await screen.findByText("dashboard")).toBeInTheDocument();

    await emit(adapter, { uid: "a", email: "owner@example.com" });
    await waitFor(() => {
      expect(requestSession).toHaveBeenCalledTimes(2);
    });

    expect(screen.getByText("dashboard")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("evicts the dashboard when a background check reports a removed allowlist entry", async () => {
    const adapter = createFakeAdapter();
    const requestSession = vi
      .fn()
      .mockResolvedValueOnce({ identity: firebaseIdentity })
      .mockRejectedValueOnce(
        new ApiRequestError("denied", "forbidden", 403, "AUTH_FORBIDDEN"),
      );
    renderGate({ mode: "firebase", createAdapter: () => adapter, requestSession });

    await emit(adapter, { uid: "a", email: "owner@example.com" });
    expect(await screen.findByText("dashboard")).toBeInTheDocument();

    await emit(adapter, { uid: "a", email: "owner@example.com" });
    expect(await screen.findByRole("alert")).toHaveTextContent("not approved for access");
    expect(screen.queryByText("dashboard")).not.toBeInTheDocument();
  });

  it("returns to sign-in when a background check cannot authenticate", async () => {
    const adapter = createFakeAdapter();
    const requestSession = vi
      .fn()
      .mockResolvedValueOnce({ identity: firebaseIdentity })
      .mockRejectedValueOnce(
        new ApiRequestError("expired", "unauthenticated", 401, "AUTH_TOKEN_INVALID"),
      );
    renderGate({ mode: "firebase", createAdapter: () => adapter, requestSession });

    await emit(adapter, { uid: "a", email: "owner@example.com" });
    expect(await screen.findByText("dashboard")).toBeInTheDocument();

    await emit(adapter, { uid: "a", email: "owner@example.com" });
    expect(
      await screen.findByRole("button", { name: "Sign in with Google" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("dashboard")).not.toBeInTheDocument();
  });

  it("runs local development with no adapter and no token", async () => {
    const createAdapter = vi.fn(() => createFakeAdapter());
    const requestSession = vi.fn(
      async (getToken: (forceRefresh: boolean) => Promise<string | null>) => {
        expect(await getToken(false)).toBeNull();
        return { identity: localIdentity };
      },
    );
    const signOutProps: (undefined | (() => void))[] = [];

    renderGate({
      mode: "local-development",
      createAdapter,
      requestSession,
      children: (_identity, onSignOut) => {
        signOutProps.push(onSignOut);
        return <Dashboard />;
      },
    });

    expect(await screen.findByText("dashboard")).toBeInTheDocument();
    expect(createAdapter).not.toHaveBeenCalled();
    expect(signOutProps.every((value) => value === undefined)).toBe(true);
  });

  it("refuses a Firebase identity while in local-development mode", async () => {
    renderGate({
      mode: "local-development",
      requestSession: () => Promise.resolve({ identity: firebaseIdentity }),
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The application is not configured yet.",
    );
    expect(screen.queryByText("dashboard")).not.toBeInTheDocument();
  });

  it("never falls back to a local identity when Firebase configuration is absent", async () => {
    const requestSession = vi.fn();
    renderGate({
      mode: "firebase",
      createAdapter: () => {
        throw new FirebaseConfigError("VITE_FIREBASE_API_KEY is not configured.");
      },
      requestSession,
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The application is not configured yet.",
    );
    expect(screen.queryByText("dashboard")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(requestSession).not.toHaveBeenCalled();
  });
});
