export type AuthenticationMethod = "cloudflare-access" | "local-development";

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

  constructor(message: string, kind: ApiErrorKind, status: number | null = null) {
    super(message);
    this.name = "ApiRequestError";
    this.kind = kind;
    this.status = status;
  }
}
