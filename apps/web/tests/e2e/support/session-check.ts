import type { Page } from '@playwright/test';

// The one session delay of every journey (#233 retro); eslint refuses a spec that declares its own.
//
// The session answers late, so that a page shows its facts before the CSRF token arrives: a write action waits for the
// token, or a quick save would be refused as if the grant were gone (#135).
//
// Every page load then waits 3 s, against a test's 30 s budget: end the delay once the first form has shown it waits.
// Journey F010-T2.1 ran past the budget with the delay left on (#233).

const SESSION_CHECK = '**/auth/session-check';

// Declared under other names: the eslint rule that keeps every spec on these refuses a declaration of theirs.

/** Makes `/auth/session-check` answer 3 s late on `page`. */
const delay = (page: Page) =>
  page.route(SESSION_CHECK, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.continue();
  });

/** Lets `/auth/session-check` answer at once again on `page`. */
const end = (page: Page) => page.unroute(SESSION_CHECK);

export { delay as delaySessionCheck, end as endSessionDelay };
