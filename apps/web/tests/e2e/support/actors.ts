import type { BrowserContext, Page } from '@playwright/test';
import type { SessionService } from '../../../../api/src/services/session.service.ts';

// The one actor switch of every journey (#208 retro); eslint refuses a spec that declares its own.
//
// The API renews the session cookie on every response, so a request still in flight from the previous actor's page
// can set that actor's cookie back after loginAs: Journey 12 of asset.spec.ts flaked that way (PR #58), and so did
// Journey F009-T6.1 of material-request.spec.ts, whose spec had copied loginAs without switchActor.
//
// A spec creates its SessionService and learns its base URL in beforeAll, so both are read when a switch runs.
export const actorSwitch = (sessions: () => SessionService, baseUrl: () => string) => {
  const actors = {
    // Gives the context the user's session cookie. Alone, it is the switch under a mounted page that the actor-switch
    // journeys test, or the first sign-in of a journey's fresh page.
    loginAs: async (context: BrowserContext, userId: string) => {
      const session = await sessions().createSession(userId);
      await context.addCookies([{ name: 'session', value: session.token, url: baseUrl() }]);
    },

    // Switches the actor on a page already in use, before the next step navigates: leaving the page first settles
    // the previous actor's requests.
    switchActor: async (page: Page, context: BrowserContext, userId: string) => {
      await page.goto('about:blank');
      await actors.loginAs(context, userId);
    },
  };
  return actors;
};
