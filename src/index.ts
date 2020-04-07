'use strict'

import { stringify } from 'querystring'
import { parse } from 'url'

import bent from 'bent'
import formUrlEncoded from 'form-urlencoded'
import jwt from 'jsonwebtoken'
import jwksClient from 'jwks-rsa'

const { name, version, homepage } = require('../package')

export interface Response {
  access_token: string,
  expires_in: number,
  token_type: string,
  refresh_token: string
}

export interface SingleSignOnOptions {
  endpoint?: string
  userAgent?: string,
  scopes?: string | string[]
}

export default class SingleSignOn {
  public readonly clientId: string
  public readonly callbackUri: string
  public readonly endpoint: string
  public readonly userAgent: string
  public readonly scopes: string[] = []
  public readonly jwksClient: jwksClient.JwksClient

  #authorization: string
  #host: string
  #request: bent.RequestFunction<Response>

  public constructor (
    clientId: string,
    secretKey: string,
    callbackUri: string,
    opts: SingleSignOnOptions = {}
  ) {
    this.clientId = clientId
    this.callbackUri = callbackUri

    this.endpoint = opts.endpoint || 'https://login.eveonline.com'
    this.userAgent = opts.userAgent || `${name}@${version} - nodejs@${process.version} - ${homepage}`

    if (opts.scopes) {
      const { scopes } = opts
      this.scopes = typeof scopes === 'string' ? scopes.split(' ') : scopes
    }

    this.#authorization = Buffer.from(`${this.clientId}:${secretKey}`).toString('base64')
    this.#host = parse(this.endpoint).hostname
    this.#request = bent(this.endpoint, 'json', 'POST') as bent.RequestFunction<Response>

    this.jwksClient = jwksClient({
      jwksUri: `${this.endpoint}/oauth/jwks`,
      requestHeaders: {
        'User-Agent': this.userAgent
      }
    })
  }

  /**
   * Get a redirect url.
   * @param  state  State string
   * @param  scopes Scopes to request
   * @return        Redirect url
   */
  public getRedirectUrl (state: string, scopes?: string | string[]) {
    let scope: string = ''

    if (scopes) {
      scope = Array.isArray(scopes) ? scopes.join(' ') : scopes
    } else if (this.scopes) {
      scope = this.scopes.join(' ')
    }

    const query: any = {
      response_type: 'code',
      redirect_uri: this.callbackUri,
      client_id: this.clientId,
      scope,
      state
    }

    return `${this.endpoint}/v2/oauth/authorize?${stringify(query)}`
  }

  /**
   * Get an access token from an authorization code or refresh token.
   * @param  code           The authorization code or refresh token
   * @param  isRefreshToken Whether or not a refresh token is used
   * @param  scopes         A subset of the specified scopes
   * @return                An object containing, among other things,
   * the access token and refresh token
   */
  public async getAccessToken (
    code: string,
    isRefreshToken?: boolean,
    scopes?: string | string[]
  ) {
    let payload: any

    if (!isRefreshToken) {
      payload = {
        grant_type: 'authorization_code',
        code
      }
    } else {
      payload = {
        grant_type: 'refresh_token',
        refresh_token: code
      }

      if (scopes) {
        payload.scope = Array.isArray(scopes) ? scopes.join(' ') : scopes
      }
    }

    const reply = await this.#request('/v2/oauth/token', formUrlEncoded(payload), {
      Host: this.#host,
      Authorization: `Basic ${this.#authorization}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': this.userAgent
    })

    await this.validateAccessToken(reply.access_token)

    return reply
  }

  public async validateAccessToken (
    accessToken: string
  ): Promise<void> {
    const decoded = jwt.decode(accessToken, {
      complete: true
    }) as { [key: string]: any }
    const { kid } = decoded.header
    const key = await this.getSigningKey(kid)

    await this.verifyToken(accessToken, key)
  }

  private async verifyToken (
    accessToken: string,
    key: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      jwt.verify(accessToken, key, {
        issuer: [ this.endpoint, this.#host ]
      }, err => {
        if (err) {
          return reject(err)
        }

        resolve()
      })
    })
  }

  private async getSigningKey (kid: string) {
    return new Promise<string>((resolve, reject) => {
      this.jwksClient.getSigningKey(kid, (err, key) => {
        if (err) {
          return reject(err)
        }

        resolve(key.getPublicKey())
      })
    })
  }
}
