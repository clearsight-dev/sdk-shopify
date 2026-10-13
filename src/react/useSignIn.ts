import { useCallback, useEffect, useRef, useState } from "react";
import type { SignupInput } from "../auth/session";
import type { AuthMethod, SignInAttempt } from "../types";
import { useCustomer, useShopify } from "./ShopifyProvider";

export interface UseSignInOptions {
  /**
   * The sign-in happens on a page of the app's own: email and password, or Shopify's page in a web
   * view (`auth.signInSurface: 'webview'`). The app opens it (its `useSignInPage` does the rest).
   */
  onOpenSignInPage?: (method: AuthMethod) => void;
  /**
   * Raise `auth:couldNotReachStore` (its alert says so) when the system sheet can't reach the store.
   * Default false: `failed` says so, for a screen that shows it itself.
   */
  alertOnFailure?: boolean;
}

export interface SignIn {
  /** Starts the sign-in the app offers now: the app's own page, or Shopify's in the system sheet. */
  start: () => Promise<void>;
  /** The system sheet is open. */
  signingIn: boolean;
  /** The last system-sheet sign-in couldn't reach the store. Cleared by the next start. */
  failed: boolean;
}

/**
 * Signing in from anywhere (0.15.0, moved from amore-v2's `useSignIn`): the sign-in itself is
 * `useCustomer`'s; this chooses where it happens, by `auth.method` and `auth.signInSurface`.
 */
export function useSignIn(options: UseSignInOptions = {}): SignIn {
  const customer = useCustomer();
  const { report } = useShopify();
  const [signingIn, setSigningIn] = useState(false);
  const [failed, setFailed] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const { method, signInSurface, signIn } = customer;

  const start = useCallback(async () => {
    setFailed(false);
    const { onOpenSignInPage, alertOnFailure } = optionsRef.current;
    if (method === "password") {
      onOpenSignInPage?.("password");
      return;
    }
    if (signInSurface === "webview") {
      onOpenSignInPage?.("shopify");
      return;
    }
    setSigningIn(true);
    try {
      await signIn();
    } catch (error) {
      console.warn("[sdk-shopify] sign-in failed", error);
      setFailed(true);
      if (alertOnFailure) report("auth:couldNotReachStore", { error });
    } finally {
      setSigningIn(false);
    }
  }, [method, signInSurface, signIn, report]);

  return { start, signingIn, failed };
}

/** What a password sign-in page remembers between openings (never the password). */
export interface SignInFormDetails {
  email: string;
  firstName: string;
  lastName: string;
}

/** Kept for the app's session: the email and names last typed, for the next opening. */
let rememberedDetails: SignInFormDetails | undefined;

export interface UseSignInPageOptions {
  /** Which sign-in the page shows (`useSignIn`'s `onOpenSignInPage` says). */
  method: AuthMethod;
  /** The page is done: signed in, or Shopify's page couldn't start. The app closes it. */
  onDone: () => void;
}

export interface SignInPage {
  password: {
    /** A sign-in, sign-up or reset is on its way. */
    busy: boolean;
    /** The email and names last typed (never the password), for the form to open with. */
    rememberedDetails: SignInFormDetails | undefined;
    /** The form's email and names as they're typed. */
    rememberDetails: (details: SignInFormDetails) => void;
    /** True once signed in (then `onDone`); false for wrong details (`auth:loginFailed` says so). */
    signIn: (email: string, password: string) => Promise<boolean>;
    signUp: (input: SignupInput) => Promise<boolean>;
    resetPassword: (email: string) => Promise<void>;
  };
  shopify: {
    /** Shopify's sign-in page, once the attempt has started. */
    url: string | undefined;
    /** Whether an address is the attempt's way back to the app. */
    isCallback: ((url: string) => boolean) | undefined;
    /** The way back's scheme (`shop.123.app`), so a web view lets it through. */
    callbackScheme: string | null;
    /** The web view reached the way back: signs in, then `onDone`. Throws when the store can't be reached. */
    finish: (callbackUrl: string) => Promise<void>;
  };
}

/**
 * A sign-in page (0.15.0, moved from amore-v2's `useSignInPage`): email and password, or Shopify's page
 * in the app's web view. Signing in calls `onDone`.
 *
 * Shopify's page: one attempt per opening, started when the page opens (`method: 'shopify'`) and
 * cancelled if the page closes first. One that can't start (no connection) raises
 * `auth:couldNotReachStore` and calls `onDone`.
 */
export function useSignInPage({ method, onDone }: UseSignInPageOptions): SignInPage {
  const customer = useCustomer();
  const { report } = useShopify();
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const done = useCallback(() => onDoneRef.current(), []);

  const [attempt, setAttempt] = useState<SignInAttempt | null>(null);
  const finished = useRef(false);
  const { startSignIn } = customer;
  useEffect(() => {
    if (method !== "shopify") return;
    let started: SignInAttempt;
    try {
      started = startSignIn();
    } catch (error) {
      console.warn("[sdk-shopify] sign-in failed to start", error);
      report("auth:couldNotReachStore", { error });
      onDoneRef.current();
      return;
    }
    setAttempt(started);
    return () => {
      if (!finished.current) started.cancel();
    };
    // One attempt per opening: only the method starts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method]);

  const { login, signup, recoverPassword } = customer;
  const signIn = useCallback(
    async (email: string, password: string) => {
      const ok = await login(email, password);
      if (ok) done();
      return ok;
    },
    [login, done],
  );
  const signUp = useCallback(
    async (input: SignupInput) => {
      const ok = await signup(input);
      if (ok) done();
      return ok;
    },
    [signup, done],
  );
  const finish = useCallback(
    async (callbackUrl: string) => {
      if (!attempt) return;
      await attempt.finish(callbackUrl);
      finished.current = true;
      done();
    },
    [attempt, done],
  );
  const rememberDetails = useCallback((details: SignInFormDetails) => {
    rememberedDetails = details;
  }, []);

  return {
    password: {
      busy: customer.loading,
      rememberedDetails,
      rememberDetails,
      signIn,
      signUp,
      resetPassword: recoverPassword,
    },
    shopify: {
      url: attempt?.url,
      isCallback: attempt ? (url: string) => attempt.isCallback(url) : undefined,
      callbackScheme: attempt ? attempt.redirectUri.slice(0, attempt.redirectUri.indexOf("://")) : null,
      finish,
    },
  };
}
