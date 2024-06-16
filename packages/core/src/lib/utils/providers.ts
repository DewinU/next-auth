import * as o from "oauth4webapi"
import { merge } from "./merge.js"

import type {
  AccountCallback,
  OAuthConfig,
  OAuthConfigInternal,
  OAuthEndpointType,
  OAuthUserConfig,
  ProfileCallback,
  Provider,
} from "../../providers/index.js"
import type { Awaitable, InternalProvider, Profile } from "../../types.js"
import type { AuthConfig } from "../../index.js"

/**
 * Adds `signinUrl` and `callbackUrl` to each provider
 * and deep merge user-defined options.
 */
export default async function parseProviders(params: {
  providers: Provider[]
  url: URL
  providerId?: string
  options: AuthConfig
}): Promise<{
  providers: InternalProvider[]
  provider?: InternalProvider
}> {
  const { providerId, options } = params
  const url = new URL(options.basePath ?? "/auth", params.url.origin)

  const providers = await Promise.all(
    params.providers.map<Awaitable<InternalProvider>>(async (p) => {
      const provider = typeof p === "function" ? p() : p
      const { options: userOptions, ...defaults } = provider

      const id = (userOptions?.id ?? defaults.id) as string
      // TODO: Support if properties have different types, e.g. authorization: string or object
      const merged = merge(defaults, userOptions, {
        signinUrl: `${url}/signin/${id}`,
        callbackUrl: `${url}/callback/${id}`,
      })

      if (provider.type === "oauth" || provider.type === "oidc") {
        merged.redirectProxyUrl ??= options.redirectProxyUrl
        return normalizeOAuth(merged)
      }

      return merged
    })
  )

  return {
    providers,
    provider: providers.find(({ id }) => id === providerId),
  }
}

async function normalizeOAuth(c: OAuthConfig<any> | OAuthUserConfig<any>) {
  let authorization: OAuthConfigInternal<any>["authorization"] | undefined
  if (c.issuer) {
    const issuer = new URL(c.issuer)
    try {
      const discoveryResponse = await o.discoveryRequest(issuer)
      const as = await o.processDiscoveryResponse(issuer, discoveryResponse)

      if (!as.authorization_endpoint) {
        throw new TypeError(
          "Authorization server did not provide an authorization endpoint."
        )
      }
      const authorizationUrl = new URL(as.authorization_endpoint)
      authorizationUrl.searchParams.set("scope", "openid profile email")
      authorization = { url: authorizationUrl, as }
    } catch (e) {
      console.error(e)
      throw new Error(`Failed to discover the OAuth provider: ${e}`)
    }
  } else {
    authorization = normalizeEndpoint(c.authorization)

    if (!authorization) {
      throw new TypeError(
        "The `authorization` options must be provided for this OAuth provider."
      )
    }
  }

  const token = normalizeEndpoint(c.token)

  const userinfo = normalizeEndpoint(c.userinfo)

  const checks = c.checks ?? ["pkce"]
  if (c.redirectProxyUrl) {
    if (!checks.includes("state")) checks.push("state")
    c.redirectProxyUrl = `${c.redirectProxyUrl}/callback/${c.id}`
  }

  return {
    ...c,
    authorization,
    token,
    checks,
    userinfo,
    profile: c.profile ?? defaultProfile,
    account: c.account ?? defaultAccount,
  }
}

/**
 * Returns basic user profile from the userinfo response/`id_token` claims.
 * The returned `id` will become the `account.providerAccountId`. `user.id`
 * and `account.id` are auto-generated UUID's.
 *
 * The result if this function is used to create the `User` in the database.
 * @see https://authjs.dev/reference/core/adapters#user
 * @see https://openid.net/specs/openid-connect-core-1_0.html#IDToken
 * @see https://openid.net/specs/openid-connect-core-1_0.html#
 */
const defaultProfile: ProfileCallback<Profile> = (profile) => {
  return stripUndefined({
    id: profile.sub ?? profile.id ?? crypto.randomUUID(),
    name: profile.name ?? profile.nickname ?? profile.preferred_username,
    email: profile.email,
    image: profile.picture,
  })
}

/**
 * Returns basic OAuth/OIDC values from the token response.
 * @see https://www.ietf.org/rfc/rfc6749.html#section-5.1
 * @see https://openid.net/specs/openid-connect-core-1_0.html#TokenResponse
 * @see https://authjs.dev/reference/core/adapters#account
 */
const defaultAccount: AccountCallback = (account) => {
  return stripUndefined({
    access_token: account.access_token,
    id_token: account.id_token,
    refresh_token: account.refresh_token,
    expires_at: account.expires_at,
    scope: account.scope,
    token_type: account.token_type,
    session_state: account.session_state,
  })
}

function stripUndefined<T extends object>(o: T): T {
  const result = {} as any
  for (let [k, v] of Object.entries(o)) v !== undefined && (result[k] = v)
  return result as T
}

function normalizeEndpoint(e?: OAuthConfig<any>[OAuthEndpointType]) {
  if (!e) return
  if (typeof e === "string") {
    return { url: new URL(e) }
  }
  // If e.url is undefined, it's because the provider config
  // assumes that we will use the issuer endpoint.
  // The existence of either e.url or provider.issuer is checked in
  // assert.ts. We fallback to "https://authjs.dev" to be able to pass around
  // a valid URL even if the user only provided params.
  // NOTE: This need to be checked when constructing the URL
  // for the token and userinfo endpoints.
  const url = new URL(e?.url ?? "https://authjs.dev")
  if (e?.params != null) {
    for (let [key, value] of Object.entries(e.params)) {
      if (key === "claims") value = JSON.stringify(value)
      url.searchParams.set(key, String(value))
    }
  }
  return { url, request: e?.request, conform: e?.conform }
}

export function isOIDCProvider(
  provider: InternalProvider<"oidc" | "oauth">
): provider is InternalProvider<"oidc"> {
  return provider.type === "oidc"
}

export function isOAuth2Provider(
  provider: InternalProvider<"oidc" | "oauth">
): provider is InternalProvider<"oauth"> {
  return provider.type === "oauth"
}

/** Either OAuth 2 or OIDC */
export function isOAuthProvider(
  provider: InternalProvider<any>
): provider is InternalProvider<"oauth" | "oidc"> {
  return provider.type === "oauth" || provider.type === "oidc"
}
