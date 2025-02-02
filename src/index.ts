import fetch from 'node-fetch'
import formUrlEncoded from 'form-urlencoded'
import jwt from 'jsonwebtoken'
import jwks from 'jwks-rsa'

const { name, version, homepage } = require('../package')

export type Options = {
  endpoint?: string,
  userAgent?: string,
}

export type AccessToken = {
  scp: string | string[],
  jti: string,
  kid: string,
  sub: string,
  azp: string,
  name: string,
  owner: string,
  exp: number,
  iss: string
}

export type Response = {
  access_token: string,
  token_type: string,
  refresh_token: string,
  expires_in: number,
  decoded_access_token: AccessToken,
}

const ENDPOINT = 'https://login.eveonline.com'

export default class SingleSignOn {
  public readonly clientId: string
  public readonly callbackUri: string
  public readonly endpoint: string
  public readonly host: string
  public readonly userAgent: string

  #authorization: string
  #jwks: jwks.JwksClient

  public constructor(
    clientId: string,
    secretKey: string,
    callbackUri: string,
    {
      endpoint,
      userAgent,
    }: Options = {}
  ) {
    this.clientId = clientId
    this.callbackUri = callbackUri
    this.#authorization = Buffer.from(`${clientId}:${secretKey}`).toString('base64')

    this.endpoint = endpoint ?? ENDPOINT
    this.host = new URL(this.endpoint).hostname
    this.userAgent = userAgent ?? `${name}@${version} - nodejs@${process.version} - ${homepage}`

    this.#jwks = jwks({
      jwksUri: `${this.endpoint}/oauth/jwks`,
      requestHeaders: {
        'User-Agent': this.userAgent
      }
    })
  }

  public getRedirectUrl(state: string, scopes?: string | string[]): string {
    let scope = ''

    if (scopes) {
      if (Array.isArray(scopes)) {
        scope = scopes.join(' ')
      } else {
        scope = scopes
      }
    }

    const search = new URLSearchParams({
      response_type: 'code',
      redirect_uri: this.callbackUri,
      client_id: this.clientId,
      scope,
      state
    })

    return `${this.endpoint}/v2/oauth/authorize?${search.toString()}`
  }

  public async getAccessToken(code: string, isRefreshToken = false) {
    const payload = !isRefreshToken ? {
      grant_type: 'authorization_code',
      code
    } : {
      grant_type: 'refresh_token',
      refresh_token: code,
    }

    const response = await fetch(`${this.endpoint}/v2/oauth/token`, {
      method: 'POST',
      body: formUrlEncoded(payload),
      headers: {
        Host: this.host,
        Authorization: `Basic ${this.#authorization}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': this.userAgent,
      }
    })

    if (!response.ok) {
      throw new Error(`Got status code ${response.status}`)
    }

    const data = await response.json() as Response

    data.decoded_access_token = await new Promise<AccessToken>((resolve, reject) => {
      jwt.verify(data.access_token, this.getKey.bind(this), {
        issuer: [this.endpoint, this.host]
      }, (err, decoded) => {
        if (err) return reject(err)
        resolve(decoded as AccessToken)
      })
    })

    return data
  }

  private getKey(header: any, callback: Function) {
    this.#jwks.getSigningKey(header.kid, (err, key) => {
      if (err) return callback(err)
      callback(null, key.getPublicKey())
    })
  }
}
