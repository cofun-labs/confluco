import { SignJWT, exportSPKI, generateKeyPair } from 'jose'

/**
 * Stands in for Clerk: holds a real RSA key pair and issues RS256 session
 * tokens shaped like Clerk's. The worker verifies them with the public key
 * exactly as it does in production (CLERK_JWT_KEY).
 */
export class FakeClerk {
  private constructor(
    private privateKey: CryptoKey,
    readonly publicKeyPem: string,
  ) {}

  static async create(): Promise<FakeClerk> {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
    return new FakeClerk(privateKey, await exportSPKI(publicKey))
  }

  async sessionToken(opts: { userId: string; azp?: string; expiresInSec?: number }): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    return new SignJWT({ sid: 'sess_test', ...(opts.azp ? { azp: opts.azp } : {}) })
      .setProtectedHeader({ alg: 'RS256', kid: 'ins_test' })
      .setSubject(opts.userId)
      .setIssuer('https://clerk.test.dev')
      .setIssuedAt(now - 5)
      .setNotBefore(now - 5)
      .setExpirationTime(now + (opts.expiresInSec ?? 60))
      .sign(this.privateKey)
  }
}
