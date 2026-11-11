// A fake Clerk for the side panel's UI tests: the part of @clerk/chrome-extension the panel uses,
// with the session held in memory. vitest.config.ts resolves '@clerk/chrome-extension' to this
// file, so the panel's own code runs unchanged. The prop types come from the real package, so a
// prop the panel passes that Clerk does not take is still a type error.
import type * as Clerk from '@clerk/chrome-extension'
import { useState, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react'

/** A signed-in user: `getToken` returns a fresh session token, as Clerk's does. */
export interface FakeSession {
  userId: string
  getToken: () => Promise<string | null>
}

let session: FakeSession | undefined
const listeners = new Set<() => void>()

function setSession(next: FakeSession | undefined) {
  session = next
  for (const listener of listeners) listener()
}

/** What a test sets up before the panel boots: who is signed in, if anyone. */
export const fakeClerk = {
  signIn: (next: FakeSession) => setSession(next),
  signOut: () => setSession(undefined),
}

function useSession(): FakeSession | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => session,
  )
}

type ProviderProps = Pick<
  ComponentProps<typeof Clerk.ClerkProvider>,
  'publishableKey' | 'syncHost' | 'afterSignOutUrl' | 'signInFallbackRedirectUrl' | 'signUpFallbackRedirectUrl'
> & { children: ReactNode }

export function ClerkProvider({ children }: ProviderProps) {
  return <>{children}</>
}

export function Show({ when, children }: { when: 'signed-in' | 'signed-out'; children: ReactNode }) {
  const signedIn = useSession() !== undefined
  return signedIn === (when === 'signed-in') ? <>{children}</> : null
}

// Keeps its identity between renders, as Clerk's does.
const noToken = async () => null

export function useAuth() {
  const current = useSession()
  return {
    isLoaded: true,
    isSignedIn: current !== undefined,
    userId: current?.userId ?? null,
    getToken: current?.getToken ?? noToken,
    signOut: async () => fakeClerk.signOut(),
  }
}

/** Like Clerk's: a button that opens the user's menu, which has "Sign out". */
export function UserButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button aria-label="Open user menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} />
      {open && (
        <div role="menu">
          <button role="menuitem" onClick={() => fakeClerk.signOut()}>
            Sign out
          </button>
        </div>
      )}
    </>
  )
}
