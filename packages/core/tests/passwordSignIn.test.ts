import faker from '@faker-js/faker'
import { interpret } from 'xstate'
import { waitFor } from 'xstate/lib/waitFor'
import { createAuthMachine } from '../src/machines'
import { Typegen0 } from '../src/machines/index.typegen'
import { BASE_URL } from './helpers/config'
import {
  authTokenNetworkErrorHandler,
  correctEmailPasswordWithMfaHandler,
  emailPasswordNetworkErrorHandler,
  incorrectEmailPasswordHandler,
  unverifiedEmailErrorHandler
} from './helpers/handlers'
import server from './helpers/server'
import customStorage from './helpers/storage'
import { GeneralAuthState } from './helpers/types'

type AuthState = GeneralAuthState<Typegen0>

// Initializing AuthMachine with custom storage to have control over its content between tests
const authMachine = createAuthMachine({
  backendUrl: BASE_URL,
  clientUrl: 'http://localhost:3000',
  clientStorage: customStorage,
  clientStorageType: 'custom',
  refreshIntervalTime: 1
})

const authService = interpret(authMachine)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

beforeEach(() => {
  authService.start()
})

afterEach(() => {
  authService.stop()
  customStorage.clear()
  server.resetHandlers()
})

test(`should fail if network is unavailable`, async () => {
  server.use(emailPasswordNetworkErrorHandler, authTokenNetworkErrorHandler)

  authService.send({
    type: 'SIGNIN_PASSWORD',
    email: faker.internet.email(),
    password: faker.internet.password(15)
  })

  const state: AuthState = await waitFor(authService, (state: AuthState) =>
    state.matches({ authentication: { signedOut: { failed: 'server' } } })
  )

  expect(state.context.errors).toMatchInlineSnapshot(`
    {
      "authentication": {
        "error": "OK",
        "message": "Network Error",
        "status": 200,
      },
    }
  `)
})

test(`should fail if server returns an error`, async () => {
  server.use(emailPasswordNetworkErrorHandler, authTokenNetworkErrorHandler)

  authService.send({
    type: 'SIGNIN_PASSWORD',
    email: faker.internet.email(),
    password: faker.internet.password(15)
  })

  const state: AuthState = await waitFor(authService, (state: AuthState) =>
    state.matches({ authentication: { signedOut: { failed: 'server' } } })
  )

  expect(state.context.errors).toMatchInlineSnapshot(`
    {
      "authentication": {
        "error": "OK",
        "message": "Network Error",
        "status": 200,
      },
    }
  `)
})

test(`should retry token refresh if refresh endpoint is unreachable`, async () => {
  server.use(authTokenNetworkErrorHandler)

  authService.send({
    type: 'SIGNIN_PASSWORD',
    email: faker.internet.email(),
    password: faker.internet.password(15)
  })

  await waitFor(authService, (state: AuthState) =>
    state.matches({
      authentication: { signedIn: { refreshTimer: { running: 'refreshing' } } }
    })
  )

  const state: AuthState = await waitFor(authService, (state: AuthState) =>
    state.matches({
      authentication: { signedIn: { refreshTimer: { running: 'pending' } } }
    })
  )

  expect(state.context.refreshTimer.attempts).toBeGreaterThan(0)
})

test(`should fail if either email or password is incorrectly formatted`, async () => {
  // Scenario 1: Providing an invalid email address with a valid password
  authService.send({
    type: 'SIGNIN_PASSWORD',
    email: faker.internet.userName(),
    password: faker.internet.password(15)
  })

  const emailErrorSignInState: AuthState = await waitFor(
    authService,
    (state: AuthState) => !!state.value
  )

  expect(
    emailErrorSignInState.matches({
      authentication: { signedOut: { failed: { validation: 'email' } } }
    })
  ).toBeTruthy()

  // Scenario 2: Providing a valid email address with an invalid password
  authService.send({
    type: 'SIGNIN_PASSWORD',
    email: faker.internet.email(),
    password: faker.internet.password(2)
  })

  const passwordErrorSignInState: AuthState = await waitFor(
    authService,
    (state: AuthState) => !!state.value
  )

  expect(
    passwordErrorSignInState.matches({
      authentication: { signedOut: { failed: { validation: 'password' } } }
    })
  ).toBeTruthy()
})

test(`should fail if incorrect credentials are provided`, async () => {
  server.use(incorrectEmailPasswordHandler)

  authService.send({
    type: 'SIGNIN_PASSWORD',
    email: faker.internet.email(),
    password: faker.internet.password(15)
  })

  const state: AuthState = await waitFor(authService, (state: AuthState) =>
    state.matches({ authentication: { signedOut: { failed: 'server' } } })
  )

  expect(state.context.errors).toMatchInlineSnapshot(`
    {
      "authentication": {
        "error": "invalid-email-password",
        "message": "Incorrect email or password",
        "status": 401,
      },
    }
  `)
})

test(`should fail if user email needs verification`, async () => {
  server.use(unverifiedEmailErrorHandler)

  authService.send({
    type: 'SIGNIN_PASSWORD',
    email: faker.internet.email(),
    password: faker.internet.password(15)
  })

  const state: AuthState = await waitFor(authService, (state: AuthState) =>
    state.matches({ authentication: { signedOut: { failed: 'server' } } })
  )

  expect(state.context.errors).toMatchInlineSnapshot(`
    {
      "authentication": {
        "error": "unverified-email",
        "message": "Email needs verification",
        "status": 401,
      },
    }
  `)
})

test(`should save MFA ticket if MFA is set up for the account`, async () => {
  server.use(correctEmailPasswordWithMfaHandler)

  authService.send({
    type: 'SIGNIN_PASSWORD',
    email: faker.internet.email(),
    password: faker.internet.password(15)
  })

  const signInPasswordState: AuthState = await waitFor(authService, (state: AuthState) =>
    state.matches({ authentication: { signedOut: 'needsMfa' } })
  )

  expect(signInPasswordState.context.mfa.ticket).not.toBeNull()

  // Note: MFA ticket is already in context
  authService.send({
    type: 'SIGNIN_MFA_TOTP',
    otp: faker.random.numeric(6)
  })

  const mfaTotpState: AuthState = await waitFor(authService, (state: AuthState) =>
    state.matches({ authentication: { signedIn: { refreshTimer: { running: 'pending' } } } })
  )

  expect(mfaTotpState.context.user).not.toBeNull()
})

test(`should succeed if correct credentials are provided`, async () => {
  authService.send({
    type: 'SIGNIN_PASSWORD',
    email: faker.internet.email(),
    password: faker.internet.password(15)
  })

  const state: AuthState = await waitFor(authService, (state: AuthState) =>
    state.matches({ authentication: { signedIn: { refreshTimer: { running: 'pending' } } } })
  )

  expect(state.context.user).not.toBeNull()
})