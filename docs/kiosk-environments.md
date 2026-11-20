# Kiosk environment list (`environments.json`)

The Android, iOS and laptop kiosks let someone pick a named environment in
Settings › This Kiosk. The names come from one file. The status site and
Sirdar will publish it later; until then the request fails and kiosks use
the list built into the app.

## URL

`GET https://status.serversherpa.com/environments.json`

https only. Kiosks follow no redirects, send no cookies and wait 5 seconds.
The file is capped at 64 KB.

## Shape

```json
{
  "version": 1,
  "environments": [
    { "id": "prod",  "name": "Prod",  "domain": "serversherpa.com" },
    { "id": "rc1",   "name": "RC1",   "domain": "rc1.serversherpa.com" },
    { "id": "uat",   "name": "UAT",   "domain": "uat.serversherpa.com" },
    { "id": "beta",  "name": "Beta",  "domain": "beta.serversherpa.com" },
    { "id": "alpha", "name": "Alpha", "domain": "alpha.serversherpa.com" },
    { "id": "dev",   "name": "Dev",   "domain": "dev.serversherpa.com" }
  ]
}
```

These six are also the built-in list, in this order.

## Field rules

- `version` must be `1`. Any other value makes the whole file unusable.
- `id` is the stable key a kiosk saves. It matches `^[a-z][a-z0-9-]{1,31}$`
  and does not end in a hyphen (Sirdar's environment-name rule, except that
  `prod` is allowed).
- `name` is what people see. It must be a non-empty string.
- `domain` is `serversherpa.com` or ends in `.serversherpa.com`: lower-case
  letters, digits, hyphens and dots only, and no label (the part between two
  dots) starts or ends with a hyphen. No scheme, port, path or user
  info. A foreign domain is dropped, so a tampered file can't send a kiosk
  outside serversherpa.com.
- Entries are shown in file order.
- If an `id` appears twice, the first entry wins and the later one is
  dropped.
- A bad entry is dropped on its own. The file is used only if at least one
  entry survives.

## Addresses

A kiosk builds every address from `domain`:

- API: `https://api.<domain>`
- Portal: `https://portal.<domain>`

Prod is the entry whose domain is exactly `serversherpa.com`. Kiosks show
no badge on Prod and a name badge on every other environment.

## Where a kiosk gets the list

In order:

1. A fresh download, made when the person opens the chooser.
2. The last good download, saved on the device.
3. The built-in list.

## A saved environment never moves

When someone switches, the kiosk saves the environment's `id`, `name` and
the `domain` it resolved, and keeps using that saved domain. Changing a
domain in the list, or removing the entry, does not move any kiosk. Only a
switch by a person does, because a switch also wipes the old server's data.
A kiosk whose saved `id` now has a different domain in the list shows that
entry as an ordinary choice.

## CORS

No CORS headers are needed. Native apps and the laptop's local service (the
edge) download the file, not a browser. The laptop's kiosk web app asks the
edge for the list.
