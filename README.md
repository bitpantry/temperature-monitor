# Temperature Monitor

A weekend build for anyone who’s ever opened a cooler for the fifth time to check a turkey brine. It grew out of trying [Alton Brown’s fried turkey recipe](https://altonbrown.com/recipes/deep-fried-turkey/). A little Wi-Fi board reads a probe about once a minute; a dashboard shows what’s happening without you lifting the lid.

The project has two parts: [the dashboard and API](dashboard/) and [the board firmware](firmware/BrineMonitor/). Use any compatible WeMos D1 Mini (ESP8266), not an ESP32. If you already have a board and a few resistors, the main thing to buy is the probe.

**For food use:** use a thermometer and probe suitable for your setup, and independently verify with a reliable food thermometer. A failed sensor, Wi-Fi outage or delayed notification can make the dashboard stale. Neither the app nor a scheduled alert makes a brining method safe. This project only monitors; it does not cool anything or control a fryer.

## 1. Wire the board

- WeMos D1 Mini, 2.4 GHz Wi-Fi, USB **data** cable, and a USB power supply.
- DS18B20 probe. Only immerse parts explicitly rated for the conditions; keep unsealed joints and electronics dry. Use a suitable food-contact probe or a suitable food-safe thermowell for contact with brine.
- 4.7 kΩ resistor, unless the probe module already has the pull-up.
- Optional RGB LED and three 330 Ω resistors, plus a breadboard or perfboard and wires.

Unplug USB before wiring. Check the probe’s pinout rather than assuming wire colors.

| Connection | D1 Mini |
| --- | --- |
| Probe power | 3V3 |
| Probe ground | GND |
| Probe data | D5 (GPIO14) |
| 4.7 kΩ pull-up | Between D5 and 3V3, not in series with power |
| RGB LED red, green, blue | D1, D2, D6 respectively, each through a 330 Ω resistor |
| RGB LED common | GND for common cathode; 3V3 for common anode (set firmware flag) |

Yellow means starting up. Green means the server recently confirmed a reading; a short blue blink marks a new accepted upload while already green. Red means the board is having trouble with the probe, connection or upload. The LED is dark when the server reports monitoring off. **The LED does not signal whether the temperature itself is safe.**

## 2. Set up the dashboard

The original used ChatGPT Sites and a D1 database. This copy can use your own Cloudflare Worker with D1 so you do not need access to the original Site. Install Node.js 24 or newer. Then, from the cloned repo:

```sh
cd dashboard
npm test
npm run build
npm run validate
npx wrangler login
npx wrangler d1 create temperature-monitor
cp wrangler.example.toml wrangler.toml
```

Put the D1 database ID Wrangler returned in `wrangler.toml`. These commands create and deploy to **your own account**; review your plan and any usage charges first.

```sh
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
npx wrangler secret put MONITOR_ADMIN_KEY
```

Generate an owner key with `openssl rand -hex 32`, store it in your password manager, and paste it into the **secret prompt**, not a config file. Repeat with a **different** key for `MONITOR_STATUS_KEY` if you want optional monitoring checks. Visit your Worker URL, click **Sign in to manage**, and sign in as `owner` with the owner key. Click **Start monitoring**. The dashboard intentionally exposes read-only temperatures to anyone who can reach its URL; do not associate it with private readings or deploy it publicly if that is unsuitable. Use HTTPS and leave the default owner-auth mode on Cloudflare. The optional `chatgpt-sites` mode is only for a trusted Sites gateway that strips and supplies its authenticated identity headers.

### Make a write-only key for the board

Run these from a trusted machine. Set `BASE` to your own HTTPS deployment origin, with no trailing slash. Curl prompts for the owner key. The second command displays the board key once; treat it like a password. Repeating it rotates the board key.

```sh
BASE=https://your-worker.example.com
umask 077
COOKIE_JAR=$(mktemp)
curl -fsS -u owner -c "$COOKIE_JAR" "$BASE/manage" -o /dev/null
curl -fsS -b "$COOKIE_JAR" -H "Origin: $BASE" \
  -H 'Content-Type: application/json' \
  --data '{"action":"replace"}' "$BASE/api/device-key"
rm -f "$COOKIE_JAR"
```

## 3. Configure and flash the board

In Arduino IDE, add the [ESP8266 board package](https://arduino-esp8266.readthedocs.io/en/latest/installing.html) and select **LOLIN(WEMOS) D1 R2 & mini** (`esp8266:esp8266:d1_mini`). The versions checked for this build were ESP8266 core **3.1.2**, OneWire **2.3.8**, and DallasTemperature **4.0.6**.

In `firmware/BrineMonitor/`, copy `Secrets.example.h` to `Secrets.h`. Set your 2.4 GHz Wi-Fi name/password, your HTTPS URL ending in `/api/readings`, and the write-only device key. For `BRINE_CA_PEM`, use the trusted root PEM for your hosting endpoint’s certificate chain, from the CA’s official source. Use a C++ multiline raw string, such as `R"PEM(-----BEGIN CERTIFICATE----- ... -----END CERTIFICATE-----)PEM"`, replacing the ellipsis with the actual PEM on its original lines. Do not disable TLS verification. Leave `BRINE_INGRESS_KEY` empty unless you implemented a separate narrowly scoped ingress proxy. Set `BRINE_COMMON_ANODE` only if your LED is common anode.

Open `BrineMonitor.ino` and use **Verify** and **Upload**. With Arduino CLI and those packages installed, the equivalent build command from the repo root is:

```sh
arduino-cli compile --fqbn esp8266:esp8266:d1_mini firmware/BrineMonitor
```

At 115200 baud the serial monitor reports confirmed readings or useful errors without printing secrets. Check that a real reading shows up on your own dashboard, and cross-check the probe in a well-stirred bath against a known thermometer before using it for anything important.

## 4. Optional alerts

The dashboard shows warm at 38°F, critical at 40°F, and stale after five minutes without a reading while armed. There are **no built-in texts**. If you want remote notifications, run a scheduled job on an always-on computer or a hosting service and connect that job to a notification channel you control. The sample status check uses its own read-only key, never the board or owner key. Put `MONITOR_URL` and `MONITOR_STATUS_KEY` in a private file outside the repo and run:

```sh
node --env-file=/absolute/path/to/private.env tools/check-status.mjs
```

Exit codes: **0** normal, paused, or awaiting first reading; **1** warm; **2** critical or stale; **3** the endpoint couldn't be checked. Alert on an issue starting or changing; repeat only at your chosen interval while it persists. Keep the last alert state outside the repo if your scheduler starts a new process each time. Test with the probe unplugged and the job offline before counting on the setup. Use **End monitoring** when you are finished.

## What’s in the box?

- `dashboard/`: Worker, D1 schema, responsive chart and history page, and API tests.
- `firmware/BrineMonitor/`: Arduino sketch and a blank configuration template.
- `tools/`: optional one-shot status check for your own scheduler.

No live deployment or data, Wi-Fi credentials, device keys, or site history are included. The monitor and sketch are provided here for viewing; third-party packages have their own licenses.
