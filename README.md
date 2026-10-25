# SoundboardAnywhere

A Vencord userplugin that plays Discord soundboard sounds through your microphone, so you can use any sound on any server, even without soundboard permissions or Nitro, and even sounds from other servers.

Unlike the web-only approaches, this one also works in the **normal Discord desktop app** by routing the sounds through a virtual audio device.

[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![Vencord userplugin](https://img.shields.io/badge/Vencord-userplugin-5865F2.svg)](https://docs.vencord.dev/installing/custom-plugins/)

## Features

- Use **any** soundboard sound regardless of permissions, Nitro, or which server it is from
- Works on **Discord Web / Vesktop** (mixed straight into the WebRTC mic stream) and on the **Discord desktop app** (routed through a virtual output device)
- Adjustable microphone and sound volume, plus optional self-monitoring
- No sounds leak out while you are muted in Discord

## How it works

When you play a soundboard sound, the plugin fetches the audio from Discord's CDN and feeds it into your microphone signal instead of sending a normal soundboard event.

- **Web / Vesktop**: the sound is mixed directly into the microphone MediaStream.
- **Desktop app**: Discord's native voice engine is not reachable from JavaScript, so the plugin plays the sound into a virtual output device (for example an Elgato Wave Link channel or [VB-CABLE](https://vb-audio.com/Cable/)). You then route that device into the microphone mix Discord uses.

## Setup (desktop app)

1. Install a virtual audio device (Elgato Wave Link, [VB-CABLE](https://vb-audio.com/Cable/), or Voicemeeter).
2. In the plugin settings, set **Output device** to the name of that device/channel (a partial name is enough, e.g. `SFX` or `CABLE Input`).
3. Make sure that device is part of the mix Discord uses as the microphone.
4. Pick a mode:
   - **Sounds only** (default): the plugin only plays the sound into the device; your mixer software (Wave Link / Voicemeeter) combines it with your mic.
   - **Mix**: the plugin itself mixes your microphone and the sound into the device (use with plain VB-CABLE and set Discord's input to `CABLE Output`).

On Web / Vesktop no setup is needed; it just works.

## Usage

1. Join a voice channel.
2. Play any soundboard sound. Others hear it as if it came from your microphone.

> [!NOTE]
> If you are muted in Discord, the sounds are muted too, just like your voice.

## Installation

This is a Vencord **userplugin**, so it is not in the official plugin list. You need a [source build of Vencord](https://docs.vencord.dev/installing/).

1. Clone this repo into your Vencord userplugins folder:
   ```sh
   cd Vencord/src/userplugins
   git clone https://github.com/MagicKey08/SoundboardAnywhere
   ```
2. Build Vencord from the `Vencord` folder:
   ```sh
   pnpm build
   ```
3. Close Discord fully, then inject:
   ```sh
   pnpm inject
   ```
4. Start Discord and enable **SoundboardAnywhere** under Settings -> Vencord -> Plugins.

## Compatibility

Tested on Windows with a Vencord source build in the Discord desktop app (stable), October 2026.

Discord updates can break plugin patches at any time. If something stops working, please [open an issue](https://github.com/MagicKey08/SoundboardAnywhere/issues/new/choose) and include your Vencord version and Discord build (Settings -> scroll to the bottom of the left sidebar).

## Credits

The permission-bypass patches and the Web/Vesktop microphone mixing are based on [SoundboardPermissionsBypass](https://github.com/YashRajCodes/soundboardPermissionsBypass.web) by yash. This plugin adds the desktop-app path (virtual audio device routing), settings, and self-monitoring.

## Disclaimer

For educational purposes. Using Vencord and third-party modifications is against Discord's Terms of Service. Playing sounds through your mic may also break individual server rules. Use at your own risk.

## License

[GPL-3.0-or-later](LICENSE), the same license as Vencord.

## Author

Made by [MagicKey08](https://github.com/MagicKey08).
