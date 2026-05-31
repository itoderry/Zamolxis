---
name: home-assistant
description: Read or control Home Assistant. READ a state with http_get http://homeassistant.local:8123/api/states/<entity_id> (auth automatic; JSON has a "state" field). CONTROL a device with the ha_service tool (domain, service, entity_id) e.g. light/switch/fan turn_on|turn_off|toggle. Examples: binary_sensor.home_occupancy, weather.forecast_home, light.kitchen.
---

# Home Assistant

Authentication is automatic for both reading and controlling — never add or invent a token.

Base URL: http://homeassistant.local:8123

## Read a state (http_get, read-only)
`http_get` url: `http://homeassistant.local:8123/api/states/<entity_id>`
The JSON reply has `state` and `attributes`. Report `state` plainly.
List all: `http_get` `http://homeassistant.local:8123/api/states`

## Control a device (ha_service)
Use the `ha_service` tool: `domain`, `service`, `entity_id`.
- Turn on a light: domain=`light` service=`turn_on` entity_id=`light.kitchen`
- Turn off a switch: domain=`switch` service=`turn_off` entity_id=`switch.fan`
- Toggle: service=`toggle`. Scenes: domain=`scene` service=`turn_on`.
If you don't know the exact entity_id, first http_get `/api/states` to find it.

## Example entities
- `binary_sensor.home_occupancy` - is anyone home (on/off)
- `weather.forecast_home` - weather
- `binary_sensor.eero_wan_status` - internet up

## Rules
- Report only what the API/tool actually returns; never guess a state or claim an action you did not perform.
- Confirm with the user before anything security- or safety-related: locks, garage doors, alarms. (Unlocking and disarming are blocked outright.)
- HTTP 401 means the token is missing/expired — tell the user.