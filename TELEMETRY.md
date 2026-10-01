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
| `deployment = prod` | `personal` and `review` are our own servers (the project's test-account filter excludes them) |
| `measurement_version = 1` | a future change to how anything is counted bumps this; never mix versions in one trend |

## The events

**`node started`** — once per ComfyUI process start. Restarts, crashes and
Manager-triggered reboots all count, so this is *process starts*, not uptime and
not installs. Use it for version, platform and install-source mix, de-duplicated
by `distinct_id`.

**`frontend opened`** — each full page load of `/mobile/`. Not a session and not
a person: a browser refresh counts again, the iOS app's web view loads it when it
opens a server and whenever it reloads, and `share_extension` is the Share
Sheet's hidden page queueing a shared image, not someone looking at the app.
In-app navigation does not count, because the frontend is a single page.

**`prompt queued`** — every accepted `POST /prompt`, from **any** client: this
frontend, ComfyUI's own desktop UI, API scripts. `surface` is `ios_app` or
`share_extension` only when the request carries the CueForge app's user agent;
everything else is `web`, so `web` overstates use of *this* frontend.

**`prompt finished`** — a run leaving ComfyUI's queue, seen in its history,
whoever queued it.
- `status` comes from ComfyUI's own execution messages. A run the user
  cancelled is `interrupted`.
- `duration_bucket` is ComfyUI's execution time, start to finish. Time spent
  waiting in the queue is not included.
- `error_class` is the exception's type name only, as ComfyUI reports it.
- `model_family` is the architecture of the **most recently loaded diffusion
  model** when the run finished, as ComfyUI's own model detection names it, mapped
  to a fixed list. It is an approximation: a workflow that uses two diffusion
  models reports one, and a run that loads no diffusion model (an upscale, a
  caption) carries none. Anything ComfyUI detects that the list does not name is
  `other`. It never names the model.

**`push dispatched`** — once per finished run, per channel (`app`, `web`), when at
least one device is paired on that channel. `result` summarises every device:
`ok` if any received it. It is delivery to the relay or the browser's push service,
not proof a notification was shown.

**`request failed`** — a 5xx answered by the node's own `/mobile` routes, named by
route template. ComfyUI's core routes are not covered, and 4xx is never reported.

**`daily summary`** — once a day per install, the day's counts as ranges. The
counters live in memory, so **a restart loses the day so far**; the first
summary comes 24 hours after the install id was minted. `days_since_install_bucket`
counts from the id, so re-enabling telemetry resets it.

## Losses

Events wait in memory for at most a minute, then go to the relay in batches of up
to 50. A batch that fails to send is dropped, never retried, and at most 500
events are held, so a server that is offline for a while, or busier than that per
minute, under-reports. The relay's rate limits are approximate. Treat every count
as "at least".

## Questions it answers

- **How many installs are live?** Distinct `distinct_id` with a `daily summary` or
  `node started` in the window.
- **Which versions are they on?** `node_version` on `node started`, latest per install.
- **How reliable are generations?** `prompt finished` split by `status`, and
  `error_class` for what fails most.
- **What do people run?** `prompt finished` by `model_family`.
- **App or browser?** `frontend opened` and `prompt queued` by `surface`, with the
  `web` caveat above.
- **Do notifications get delivered?** `push dispatched` by `result`.

## Questions it cannot answer

Who uses a server, how many people do, what they make, which models or workflows
they use, why they stopped, or anything about one person. By construction.
