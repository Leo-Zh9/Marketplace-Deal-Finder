export type AuthenticationMethod = "firebase-google" | "local-development";

export interface AuthenticatedIdentity {
  email: string;
  subject: string;
  expiresAt: number;
  authenticationMethod: AuthenticationMethod;
}

export type ApiErrorKind =
  | "unauthenticated"
  | "forbidden"
  | "server"
  | "network"
  | "unexpected";

export class ApiRequestError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  /** The server's `error.code`, or null. Consumed by AuthGate's service-error branch. */
  readonly code: string | null;

  constructor(
    message: string,
    kind: ApiErrorKind,
    status: number | null = null,
    code: string | null = null,
  ) {
    super(message);
    this.name = "ApiRequestError";
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

export interface AuthUser {
  uid: string;
  email: string | null;
}

export interface AuthAdapter {
  subscribe(listener: (user: AuthUser | null) => void): () => void;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  getToken(forceRefresh: boolean): Promise<string | null>;
}

export class FirebaseConfigError extends Error {}
