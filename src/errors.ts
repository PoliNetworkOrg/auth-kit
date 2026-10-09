export type AuthKitErrorCode =
  | "snapshot_invalid"
  | "token_invalid"
  | "token_request_failed"
  | "keys_unavailable"
  | "snapshot_unavailable"
  | "actor_forbidden"

/** Every error the SDK throws on purpose. `code` is stable; `message` is for logs only. */
export class AuthKitError extends Error {
  override readonly name = "AuthKitError"

  constructor(
    readonly code: AuthKitErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}
