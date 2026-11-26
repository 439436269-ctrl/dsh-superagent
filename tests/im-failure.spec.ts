/** The IM Source reports what a person can act on: a network change must not read as a broken deployment. */
import { expect, it } from 'vitest'
import { imFailureHint } from '../src/sources/im-bridge.ts'

it('names the network change when the gateway does not resolve', () => {
  const hint = imFailureHint('[cause]: Error: getaddrinfo ENOTFOUND vanish-claw.example.com\n  at GetAddrInfoReqWrap.onlookupall')
  expect(hint).toContain('vanish-claw.example.com')
  expect(hint).toContain('corporate network')
  expect(hint).toContain('reconnects on its own')
})

it('extracts the host from a plain getaddrinfo line', () => {
  expect(imFailureHint('Error: getaddrinfo ENOTFOUND gateway.example.com')).toContain('gateway.example.com')
  expect(imFailureHint('fetch failed: getaddrinfo EAI_AGAIN gw.internal.example.org')).toContain('gw.internal.example.org')
})

it('separates an unreachable gateway from a broken certificate', () => {
  expect(imFailureHint('connect ECONNREFUSED 192.0.2.10:443')).toContain('cannot reach the gateway')
  expect(imFailureHint('Error: self signed certificate in certificate chain')).toContain('corporate root certificate')
})

it('leaves a failure it cannot explain to the raw message', () => {
  expect(imFailureHint('the bridge exited with 1: SyntaxError: unexpected token')).toBeUndefined()
  expect(imFailureHint('')).toBeUndefined()
})
