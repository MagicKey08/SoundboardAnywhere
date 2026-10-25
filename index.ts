/*
 * SoundboardAnywhere, a Vencord userplugin
 * Plays soundboard sounds through your microphone, even without soundboard
 * permissions and with sounds from other servers. Works directly on
 * Vesktop/Web, and in the normal Discord desktop app through a virtual audio
 * device (Elgato Wave Link, VB-CABLE or Voicemeeter).
 *
 * The web part is based on SoundboardPermissionsBypass by yash (GPL-3.0-or-later).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { MediaEngineStore, SelectedChannelStore, showToast } from "@webpack/common";

const logger = new Logger("SoundboardAnywhere");

const settings = definePluginSettings({
    desktopMode: {
        type: OptionType.SELECT,
        description: "Discord desktop app only: how your mic and the sounds are combined",
        options: [
            { label: "Sounds only into the output device (Elgato Wave Link, Voicemeeter, VB-CABLE with Windows \"Listen to this device\")", value: "soundsOnly", default: true },
            { label: "Plugin mixes mic + sounds into the virtual device (plain VB-CABLE without mixer software)", value: "mix" }
        ]
    },
    outputDevice: {
        type: OptionType.STRING,
        description: "Output device the sounds are played into, e.g. a Wave Link channel like \"SFX\" or \"CABLE Input\" (part of the name is enough)",
        default: "CABLE Input"
    },
    microphone: {
        type: OptionType.STRING,
        description: "Your real microphone (part of the name). Leave empty for the Windows default microphone",
        default: ""
    },
    micVolume: {
        type: OptionType.SLIDER,
        description: "Microphone volume in the mix (%)",
        markers: [0, 50, 100, 150, 200],
        default: 100,
        stickToMarkers: false
    },
    soundVolume: {
        type: OptionType.SLIDER,
        description: "Sound volume for others (%)",
        markers: [0, 25, 50, 75, 100],
        default: 80,
        stickToMarkers: false
    },
    monitor: {
        type: OptionType.BOOLEAN,
        description: "Hear the sounds yourself",
        default: true
    },
    monitorVolume: {
        type: OptionType.SLIDER,
        description: "Self-monitoring volume (%)",
        markers: [0, 25, 50, 75, 100],
        default: 50,
        stickToMarkers: false
    }
});

interface SoundboardSound {
    soundId: string;
    volume?: number;
}

/* =====================================================================
 * Web / Vesktop: Discord uses WebRTC here, so we mix straight into the mic stream
 * ===================================================================== */

interface AudioInput {
    context: AudioContext;
    mute: boolean;
    setPTTActive(active: boolean): void;
    setSpeaking(active: boolean): void;
}

interface MixedInput {
    input: AudioInput;
    sourceStream: MediaStream;
    source: MediaStreamAudioSourceNode;
    microphoneGain: GainNode;
    destination: MediaStreamAudioDestinationNode;
}

interface PlaybackSource {
    input: AudioInput;
    source: AudioBufferSourceNode;
    gain: GainNode;
}

interface Playback {
    controller: AbortController;
    sources: PlaybackSource[];
    onStop?: () => void;
}

const mixedInputs = new Map<MediaStream, MixedInput>();
const playbacks = new Set<Playback>();

function stopPlayback(active: Playback): void {
    if (!playbacks.delete(active)) return;

    active.controller.abort();
    for (const { input, source, gain } of active.sources) {
        source.onended = null;
        try { source.stop(); } catch { }
        source.disconnect();
        gain.disconnect();
        const isStillPlaying = [...playbacks].some(p => p.sources.some(s => s.input === input));
        if (input.mute) input.setSpeaking(isStillPlaying);
        else input.setPTTActive(isStillPlaying);

        for (const mixed of mixedInputs.values()) {
            if (mixed.input !== input) continue;
            mixed.microphoneGain.gain.value = input.mute ? 0 : 1;
            for (const track of mixed.destination.stream.getAudioTracks()) track.enabled = !input.mute || isStillPlaying;
        }
    }
    active.onStop?.();
}

function startWebPlayback(buffer: AudioBuffer, volume: number, active: Playback, inputs: MixedInput[]): void {
    for (const [index, { input, microphoneGain, destination }] of inputs.entries()) {
        const source = input.context.createBufferSource();
        const gain = input.context.createGain();
        source.buffer = buffer;
        gain.gain.value = volume;
        source.connect(gain).connect(destination);
        if (index === 0 && settings.store.monitor) {
            const mon = input.context.createGain();
            mon.gain.value = settings.store.monitorVolume / 100;
            gain.connect(mon).connect(input.context.destination);
        }
        source.onended = () => stopPlayback(active);
        active.sources.push({ input, source, gain });
        microphoneGain.gain.value = input.mute ? 0 : 1;
        for (const track of destination.stream.getAudioTracks()) track.enabled = true;
        if (input.mute) input.setSpeaking(true);
        else input.setPTTActive(true);
        source.start();
    }
}

/* =====================================================================
 * Discord desktop: audio goes through Discord's native voice engine, which
 * JavaScript cannot reach. So the sounds are played into a virtual audio
 * device that is part of the mic mix Discord uses.
 * ===================================================================== */

interface DesktopMixer {
    ctx: AudioContext;
    bus: GainNode;
    micStream: MediaStream | null;
    micGain: GainNode | null;
}

let mixer: DesktopMixer | null = null;
let mixerStarting: Promise<DesktopMixer | null> | null = null;
let monitorCtx: AudioContext | null = null;
let warnedInputDevice = false;
let lastStatus = "idle";

async function findDevice(kind: MediaDeviceKind, nameIncludes: string): Promise<MediaDeviceInfo | undefined> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const needle = nameIncludes.trim().toLowerCase();
    return devices.find(d => d.kind === kind && d.label.toLowerCase().includes(needle) && d.deviceId !== "default" && d.deviceId !== "communications")
        ?? devices.find(d => d.kind === kind && d.label.toLowerCase().includes(needle));
}

async function createMixer(): Promise<DesktopMixer | null> {
    const { desktopMode, outputDevice, microphone, micVolume } = settings.store;

    let micStream: MediaStream | null = null;
    if (desktopMode === "mix") {
        // ask without a device ID first so the device names become readable
        const constraints: MediaTrackConstraints = {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1
        };
        micStream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
        if (microphone.trim()) {
            const mic = await findDevice("audioinput", microphone);
            if (mic) {
                micStream.getTracks().forEach(t => t.stop());
                micStream = await navigator.mediaDevices.getUserMedia({ audio: { ...constraints, deviceId: { exact: mic.deviceId } } });
            } else {
                showToast({ text: `Microphone "${microphone}" not found, using the default microphone`, variant: "critical" });
            }
        }
    }

    const cable = await findDevice("audiooutput", outputDevice);
    if (!cable) {
        micStream?.getTracks().forEach(t => t.stop());
        lastStatus = "output device not found: " + outputDevice;
        showToast({ text: `Output device "${outputDevice}" not found. Check the name in the plugin settings.`, variant: "critical", duration: 8000 });
        return null;
    }

    const ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
    await (ctx as any).setSinkId(cable.deviceId);

    const bus = ctx.createGain();
    bus.connect(ctx.destination);

    let micGain: GainNode | null = null;
    if (micStream) {
        const src = ctx.createMediaStreamSource(micStream);
        micGain = ctx.createGain();
        micGain.gain.value = micVolume / 100;
        src.connect(micGain).connect(bus);
    }

    await ctx.resume();
    logger.info("Desktop mixer running", { cable: cable.label, mic: micStream?.getAudioTracks()[0]?.label });
    return { ctx, bus, micStream, micGain };
}

function ensureMixer(): Promise<DesktopMixer | null> {
    if (mixer) return Promise.resolve(mixer);
    if (mixerStarting) return mixerStarting;
    mixerStarting = createMixer()
        .then(m => (mixer = m))
        .catch(e => {
            logger.error("Could not start desktop mixer", e);
            showToast({ text: "SoundboardAnywhere: audio mixer could not start (" + (e?.message ?? e) + ")", variant: "critical", duration: 8000 });
            return null;
        })
        .finally(() => { mixerStarting = null; });
    return mixerStarting;
}

function stopMixer() {
    if (!mixer) return;
    mixer.micStream?.getTracks().forEach(t => t.stop());
    mixer.ctx.close().catch(() => { });
    mixer = null;
}

function syncMixerToVoice() {
    if (!IS_DISCORD_DESKTOP) return;
    const inVoice = !!SelectedChannelStore.getVoiceChannelId();
    if (inVoice && settings.store.desktopMode === "mix") void ensureMixer();
    else if (!inVoice) stopMixer();
}

function checkDiscordInputDevice() {
    if (warnedInputDevice || !/cable/i.test(settings.store.outputDevice)) return;
    try {
        const id = MediaEngineStore.getInputDeviceId();
        const device = MediaEngineStore.getInputDevices()[id];
        if (device && !/cable output/i.test(device.name)) {
            warnedInputDevice = true;
            showToast({ text: "Tip: set the input device in Discord under Voice & Video to \"CABLE Output\", otherwise others will not hear the sounds.", duration: 10000 });
        }
    } catch { }
}

async function playDesktop(sound: SoundboardSound, data: ArrayBuffer) {
    const m = await ensureMixer();
    if (!m) return;
    checkDiscordInputDevice();

    const volume = Math.max(0, Math.min(1, sound.volume ?? 1)) * (settings.store.soundVolume / 100);
    const buffer = await m.ctx.decodeAudioData(data.slice(0));
    const src = m.ctx.createBufferSource();
    const gain = m.ctx.createGain();
    src.buffer = buffer;
    gain.gain.value = volume;
    src.connect(gain).connect(m.bus);
    src.start();
    lastStatus = `played ${sound.soundId} -> ${(m.ctx as any).sinkId} at ${new Date().toISOString()}`;

    if (settings.store.monitor) {
        monitorCtx ??= new AudioContext();
        await monitorCtx.resume();
        const monBuffer = await monitorCtx.decodeAudioData(data.slice(0));
        const monSrc = monitorCtx.createBufferSource();
        const monGain = monitorCtx.createGain();
        monSrc.buffer = monBuffer;
        monGain.gain.value = Math.max(0, Math.min(1, sound.volume ?? 1)) * (settings.store.monitorVolume / 100);
        monSrc.connect(monGain).connect(monitorCtx.destination);
        monSrc.start();
    }

    // if the mixer was only started for this sound ("soundsOnly" mode), close it again afterwards
    if (settings.store.desktopMode === "soundsOnly") {
        src.onended = () => {
            if (!SelectedChannelStore.getVoiceChannelId()) stopMixer();
        };
    }
}

async function fetchSound(soundId: string, signal?: AbortSignal) {
    const res = await fetch(`https://${window.GLOBAL_ENV.CDN_HOST}/soundboard-sounds/${encodeURIComponent(soundId)}`, { signal });
    if (!res.ok) throw new Error(`Soundboard request failed with status ${res.status}`);
    return res.arrayBuffer();
}

/* ===================================================================== */

export default definePlugin({
    name: "SoundboardAnywhere",
    description: "Play soundboard sounds through your mic, even without soundboard permissions and with sounds from other servers. The desktop app needs a virtual audio device (Wave Link, VB-CABLE or Voicemeeter).",
    authors: [{ name: "MagicKey08", id: 1103681094089449565n }, { name: "yash", id: 889150838658977874n }],
    tags: ["Fun", "Voice"],
    settings,

    patches: [
        // soundboard usable everywhere (like with Nitro). The actual sending is intercepted below.
        {
            find: "canUseCustomStickersEverywhere:",
            replacement: {
                match: /(?<=canUseSoundboardEverywhere:function\(\i\)\{)/,
                replace: "return true;"
            }
        },
        // sounds from other servers even without the "Use External Sounds" permission
        {
            find: /guildId==="0"\|\|\i\?\.guildId===\i\?\.guild_id\|\|\i\?\.guildId===\i\)return!0/,
            replacement: {
                match: /\i\.\i\.can\(\i\.\i\.USE_EXTERNAL_SOUNDS,\i\)/,
                replace: "!0"
            }
        },
        // mark all sounds as available (FakeNitro does this too, hence noWarn)
        {
            find: 'type:"GUILD_SOUNDBOARD_SOUND_CREATE"',
            noWarn: true,
            replacement: {
                match: /(?<=type:"(?:SOUNDBOARD_SOUNDS_RECEIVED|GUILD_SOUNDBOARD_SOUND_CREATE|GUILD_SOUNDBOARD_SOUND_UPDATE|GUILD_SOUNDBOARD_SOUNDS_UPDATE)".{0,200}?available:)\i\.available/g,
                replace: "!0",
            },
        },
        // allow sounds from other servers
        {
            find: /getFlattenedGuildIds\(\).{0,100}USE_EXTERNAL_SOUNDS.{0,100}canUseSoundboardEverywhere/,
            replacement: {
                match: /\i\.\i\.can\(\i\.\i\.USE_EXTERNAL_SOUNDS,\i\)/,
                replace: "!0",
            },
        },
        // show the soundboard button even without permissions
        {
            find: "CALLABLE.has(e.type))return!0;let",
            replacement: {
                match: /(?<=return \i\.isGuildVoiceOrThread\(\))&&\i&&(\i)/,
                replace: "&&$1",
            },
        },
        // intercept playback: play through our mic instead of sending it to Discord
        {
            find: ".SEND_SOUNDBOARD_SOUND(",
            replacement: {
                match: /function \i\((\i),(\i),\i,\i\)\{(?=\(0,\i\.\i\)\(\2,\1\))/,
                replace: "$&return $self.playSound($1);",
            },
        },
        {
            find: ".SEND_SOUNDBOARD_SOUND(",
            replacement: [
                {
                    match: /\(\i\.\i\.canUseSoundboardEverywhere\(\i\)\|\|\i\.guildId===\i\?\.guild_id\|\|"0"===\i\.guildId\)/,
                    replace: "!0",
                },
                {
                    match: /\i\.\i\.can\(\i\.\i\.USE_EXTERNAL_SOUNDS,\i\)/,
                    replace: "!0",
                },
            ],
        },
        // Web/Vesktop only: mix into the WebRTC mic stream
        {
            find: "AudioInput: No MediaStream",
            predicate: () => !IS_DISCORD_DESKTOP,
            group: true,
            replacement: [
                {
                    match: /(?<=}else this\.stream=\i;)return this\.updateMode\(\)/,
                    replace: "this.stream=$self.mixInput(this,this.stream);return this.updateMode()",
                },
                {
                    match: /release\((\i)\)\{\1\.getTracks\(\)/,
                    replace: "release($1){$self.releaseInput($1);$1.getTracks()",
                },
                {
                    match: /(?<=\.enabled=)!this\._mute/,
                    replace: "$self.shouldEnableInput(this)",
                },
                {
                    match: /set mute\((\i)\)\{this\._mute=\1,this\.updateAudioTracks\(\),this\.setSpeaking\(!1\)/,
                    replace: "set mute($1){this._mute=$1,this.updateAudioTracks(),this.setSpeaking($self.isInputPlaying(this))",
                },
            ],
        },
    ],

    mixInput(input: AudioInput, stream: MediaStream): MediaStream {
        const source = input.context.createMediaStreamSource(stream);
        const microphoneGain = input.context.createGain();
        const destination = input.context.createMediaStreamDestination();
        source.connect(microphoneGain).connect(destination);
        mixedInputs.set(destination.stream, { input, sourceStream: stream, source, microphoneGain, destination });
        return destination.stream;
    },

    releaseInput(stream: MediaStream): void {
        const mixed = mixedInputs.get(stream);
        if (mixed == null) return;
        mixedInputs.delete(stream);
        mixed.source.disconnect();
        mixed.microphoneGain.disconnect();
        for (const track of mixed.sourceStream.getTracks()) track.stop();
    },

    shouldEnableInput(input: AudioInput): boolean {
        for (const mixed of mixedInputs.values()) {
            if (mixed.input === input) mixed.microphoneGain.gain.value = input.mute ? 0 : 1;
        }
        return !input.mute || this.isInputPlaying(input);
    },

    isInputPlaying(input: AudioInput): boolean {
        for (const playback of playbacks) {
            if (playback.sources.some(s => s.input === input)) return true;
        }
        return false;
    },

    get lastStatus() {
        return lastStatus;
    },

    async playSound(sound: SoundboardSound): Promise<void> {
        lastStatus = "playSound called " + sound?.soundId;
        const webInputs = [...mixedInputs.values()];

        try {
            // Web / Vesktop
            if (webInputs.length > 0) {
                const controller = new AbortController();
                const active: Playback = { controller, sources: [] };
                playbacks.add(active);
                try {
                    const { context } = webInputs[0].input;
                    await context.resume();
                    const data = await fetchSound(sound.soundId, controller.signal);
                    const buffer = await context.decodeAudioData(data);
                    if (!playbacks.has(active)) return;
                    const volume = Math.max(0, Math.min(1, sound.volume ?? 1)) * (settings.store.soundVolume / 100);
                    startWebPlayback(buffer, volume, active, webInputs);
                } catch (e) {
                    const { aborted } = controller.signal;
                    stopPlayback(active);
                    if (!aborted) throw e;
                }
                return;
            }

            if (!SelectedChannelStore.getVoiceChannelId()) {
                showToast({ text: "Join a voice channel first.", variant: "critical" });
                return;
            }

            if (IS_DISCORD_DESKTOP) {
                await playDesktop(sound, await fetchSound(sound.soundId));
                return;
            }

            showToast({ text: "No microphone stream found. Are you in a voice channel?", variant: "critical" });
        } catch (error) {
            logger.error("Failed to play soundboard sound", error);
            lastStatus = "error: " + error;
            showToast({ text: "Sound could not be played.", variant: "critical" });
        }
    },

    flux: {
        VOICE_CHANNEL_SELECT() {
            setTimeout(syncMixerToVoice, 0);
        }
    },

    start() {
        syncMixerToVoice();
    },

    stop() {
        for (const playback of playbacks) stopPlayback(playback);
        for (const [stream] of mixedInputs) {
            this.releaseInput(stream);
            for (const track of stream.getTracks()) track.stop();
        }
        stopMixer();
        monitorCtx?.close().catch(() => { });
        monitorCtx = null;
    },
});
