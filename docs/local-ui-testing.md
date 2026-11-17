# Testing the product locally, as its users do

`npm run check` and `npm run e2e:local` prove the code and the HTTP contract. They don't prove what a
person sees. `scripts/ui-stack.sh` runs the whole product on this machine so the real dashboard can
be driven in a browser, with any number of local users:

- **The Worker:** `wrangler dev` against this checkout's local D1.
- **The dashboard:** `vite`, on http://localhost:5173.
- **The real collector:** it runs against a saved Facebook page.
- **A fake Discord:** `scripts/e2e-discord-stub.mjs` on port 8798.

Nothing reaches production. Every D1 command is `--local`, the collector posts to 127.0.0.1, and the
only webhook is the stub.

## Why it caught things the gates did not

Driving the dashboard by hand found real defects that every automated gate passed:

- **A duplicated confirmation line.** "Stopped. Your collector skips…" appeared directly above
  "Stopped at…".
- **A "Saved" message promising a run that could not come.** While monitoring was stopped, Save said
  the collector picks this up on its next run.
- **A per-person search counter shown as if the budget were per person.** The cap is shared.
- **A wrong word in the Facebook-unavailable cause.** The message said the run "exited 5".

It also proved, in the product, that one listing reads DEAL for one user and NOT A DEAL for another,
and that each user's alerts reach only that user's own Discord path.

## A two-person session

```sh
./scripts/ui-stack.sh up --fresh   # --fresh wipes THIS checkout's local D1 first
./scripts/ui-stack.sh claim        # a fresh D1 starts unclaimed: the Worker answers 503 OWNER_UNCLAIMED
./scripts/ui-stack.sh user alice
./scripts/ui-stack.sh user bob
```

1. **Set alice up.** Open http://localhost:5173/?as=alice. Pick GPU, Toronto, 25 km, and Maximum
   price 5000, then press **Save searches**. Paste `http://127.0.0.1:8798/api/webhooks/2/alice` into
   **Discord webhook** and save it. Press **Start monitoring**.
2. **Set bob up.** Open http://localhost:5173/?as=bob. Pick GPU, Mississauga, 25 km, Maximum price
   1000, and webhook `http://127.0.0.1:8798/api/webhooks/3/bob`. Press **Start monitoring**.
3. **Feed listings and run the monitor:**
   ```sh
   ./scripts/ui-stack.sh targets                                   # one search per area, deduped
   ./scripts/ui-stack.sh ingest 43.6532 -79.3832 25 3000,800 76000000000000
   ./scripts/ui-stack.sh ingest 43.589 -79.6441 25 3000,800 76000000000000   # same ids, second area
   ./scripts/ui-stack.sh ingest 43.589 -79.6441 25 500 77000000000000        # bob's area only
   ./scripts/ui-stack.sh fire
   ./scripts/ui-stack.sh posts
   ```
4. **Check the results.**
   - alice's path receives $3,000 and $800.
   - bob's path receives $800 and $500.
   - The owner's path receives nothing, because the owner has no rule.
   - A second `fire` sends nothing more.
   - In each tab, **Preview listings** labels the $3,000 listing DEAL for alice and NOT A DEAL for bob.
5. **Stop the stack:** `./scripts/ui-stack.sh down`.

## Notes

- **One stack at a time.** It holds the same `/tmp/mdf-e2e.lock`, ports and local D1 that
  `npm run e2e:local` uses. Run `down` before running e2e.
- **The collector page is a saved fixture.** `collect` uses
  `collector/testing/fixtures/facebookSearchPage.html`, so the panel correctly reads "Degraded: the
  collector is reading a saved page". Pass another file to simulate Facebook trouble. For example, a
  login-wall page makes the collector exit 5, and the panel shows "A search, or a call to the server,
  failed".
- **Testing "database unavailable".** Start `wrangler dev` with a copy of `wrangler.local.jsonc` that
  has no `d1_databases`. The panel must say "The collector's status could not be read", never "No
  collector run has reported yet".
- **What not to use for choosing search terms.** Neither this stack nor any single live search can do
  it. A sparse query such as "atx power supply" is padded by Facebook with its generic local feed.
  That padding looks on-topic, but it overlaps the other searches and trips the collector's
  feed-overlap guard (see the history in #39 and #41). Judge a candidate query by its result-id
  overlap with the other live searches.
