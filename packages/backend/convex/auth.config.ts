/**
 * Convex custom-JWT auth for Privy.
 *
 * Privy access tokens are ES256 JWTs:
 *   iss  "privy.io"
 *   aud  the Privy app id
 *   sub  the user's Privy DID, `did:privy:...`  (== `user.id` on the clients,
 *        and therefore == `users.privyId`)
 *
 * The app id comes from the Convex deployment's environment, never the source:
 *
 *   npx convex env set PRIVY_APP_ID <your Privy app id>
 *
 * `applicationID` makes Convex reject any token whose `aud` is not this app, so
 * a token minted for a different Privy app cannot act here. Unset, this file
 * throws at push time instead of shipping a config that trusts nothing or
 * everything: there is deliberately no fallback.
 *
 * Kept self-contained (no local imports): Convex evaluates this file on its own
 * at deploy. `authConfig.test.ts` pins the shape.
 */
const appId = process.env.PRIVY_APP_ID?.trim();

if (!appId) {
  throw new Error(
    "PRIVY_APP_ID is not set on this Convex deployment. Run `npx convex env set PRIVY_APP_ID <privy app id>` and push again.",
  );
}

export default {
  providers: [
    {
      type: "customJwt" as const,
      applicationID: appId,
      issuer: "privy.io",
      jwks: `https://auth.privy.io/api/v1/apps/${appId}/jwks.json`,
      algorithm: "ES256" as const,
    },
  ],
};
