# Reading the telemetry

How to read comfyui-mobile-frontend's operational telemetry in PostHog — and,
more usefully, what it cannot tell you. Every event and field is defined in
[`contract.json`](./contract.json); this explains how they are produced.

## The unit is an install, not a person

`distinct_id` is a random install id the node mints the first time it records
anything. It is not a person, a household or a machine:

- **One server can be several installs.** Turning telemetry off deletes the id;
  turning it back on mints a new one. Deleting `user/default/mobile/telemetry.json`
  or reinstalling ComfyUI's user directory does the same.
- **Several ComfyUI instances on one machine are several installs**, each with its
  own user directory.
- **Many people can share one install.** A server with comfyui-multiuser and ten
  accounts is still one `distinct_id`; nothing per-user is ever sent.
- **Coverage is biased.** Servers that turned telemetry off, cannot reach the
  relay, or run a node older than this contract are invisible. Count what you see
  as a lower bound.

## Always filter

| Filter | Why |
| --- | --- |
| `product = node` | the app's own events share the project |
| `deployment = prod` | `dev` and `review` are our own servers (the project's test-account filter excludes them) |
| `measurement_version = 1` | a future change to how anything is counted bumps this; never mix versions in one trend |

## The events

There are only three. Activity is never sent as it happens; it is counted on the
server and sent as one **hourly summary**, so a busy install calls the relay at
most about once an hour however much it does.

**`node started`** — once per ComfyUI process start. Restarts, crashes and
Manager-triggered reboots all count, so this is *process starts*, not uptime and
not installs. Use it for version, platform and install-source mix, de-duplicated
by `distinct_id`.

**`hourly summary`** — at most once an hour, and **only for an hour in which
something happened**: an idle install sends nothing. Every count is a range
(`0`, `1`, `2-5`, `6-20`, `21-100`, `101+`), never an exact number, so to
compare installs count summaries per range rather than adding them up.

- `opens_*_bucket` — full page loads of `/mobile/`, by surface. Not sessions or
  people: a refresh counts again, the iOS app's web view loads it when it opens a
  server and whenever it reloads, and `share_extension` is the Share Sheet's
  hidden page queueing a shared image. In-app navigation does not count.
- `queued_*_bucket` — accepted `POST /prompt`s, from **any** client, by surface.
  `ios_app` and `share_extension` only when the request carries the CueForge
  app's user agent; everything else — this frontend in a browser, ComfyUI's own
  desktop UI, API scripts — is `web`, so `web` overstates use of *this* frontend.
- `succeeded_bucket`, `failed_bucket`, `interrupted_bucket` — runs leaving
  ComfyUI's queue that hour, whoever queued them, by outcome. A run the user
  cancelled is `interrupted`.
- `median_duration_bucket` — the median of that hour's run times, as a range.
  ComfyUI's execution time only; time waiting in the queue is not included.
- `top_model_family` — the architecture used by the most runs that hour, as
  ComfyUI's own model detection names it, mapped to a fixed list. Per run it is
  the most recently loaded diffusion model when the run finished, so a workflow
  using two diffusion models counts as one, and runs with none (an upscale, a
  caption) are left out. Never the model's name.
- `top_error_class` — the exception type that failed the most runs that hour, as
  ComfyUI reports it. Type name only, never the message.
- `pushes_delivered_bucket`, `pushes_failed_bucket` — finished runs whose
  notification reached the relay or the browser's push service, or did not.
  Delivery to the push service, not proof a notification was shown.
- `request_failures_bucket` — 5xx answers from the node's own `/mobile` routes.
  ComfyUI's core routes are not covered, and 4xx is never counted.

**`daily summary`** — once a day per install, active or not: whether an iOS app
is paired, and days since the install id was minted (as a range). It is the
signal that an install is still alive. The first comes 24 hours after the id is
minted, and re-enabling telemetry resets the count.

## Losses

Counts live in memory until the hour's summary is sent, so **a restart loses the
hour so far**. A summary that fails to send is dropped, never retried, so a server
that cannot reach the relay for a while under-reports. The relay's rate limits are
approximate. Treat every count as "at least".

## Questions it answers

- **How many installs are live?** Distinct `distinct_id` with a `daily summary` or
  `node started` in the window. **How many are active?** Those with an `hourly
  summary`.
- **Which versions are they on?** `node_version` on `node started`, latest per install.
- **How reliable are generations?** `failed_bucket` against `succeeded_bucket`
  across hourly summaries, and `top_error_class` for what fails most.
- **What do people run?** Hourly summaries by `top_model_family`.
- **App or browser?** The `opens_*` and `queued_*` ranges, with the `web` caveat
  above.
- **Do notifications get delivered?** `pushes_delivered_bucket` against
  `pushes_failed_bucket`.

## Questions it cannot answer

Who uses a server, how many people do, what they make, which models or workflows
they use, why they stopped, or anything about one person. By construction.
