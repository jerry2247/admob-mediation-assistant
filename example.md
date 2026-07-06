# Veo 3 — generating the FULL music video (~3 min, no loops)

Temporary scratch file — delete anytime.

Two ways to get a full-length video out of Veo. Both are fine; A is simplest, B looks the most
like a real music video.

---

## Approach A — one continuous scene (Flow "Extend")

Generate the first 8s clip, then hit **Extend** repeatedly (each extend continues from the last
frame, ~7-8s) until you pass the song length (~2:40 for Kyoto Rain → ~22 extends). Export as one
file, drop it in chat, and I mux the track under it. No looping anywhere.

- Use ONE consistent prompt for the first clip; for each extend, keep the wording almost identical
  and only nudge what changes ("they keep walking, rain continues, lanterns pass by").
- Watch for drift: after many extends the color/details can slowly degrade or morph. If it starts
  looking off around the 1-minute mark, switch to Approach B instead.
- Motion CAN progress now — walking, passing scenery, evolving sky are all fine.

**Kyoto Rain — starting clip prompt:**
Slow smooth side-tracking shot, cinematic. A young couple walks at a calm, steady pace beneath one
clear umbrella along a stone path beside a narrow Kyoto canal at dusk, gentle rain falling,
raindrops rippling across the canal, warm paper lanterns and machiya wooden townhouses drifting past,
their reflections shimmering in the wet stone and water, willow branches swaying, thin mist. Warm
lantern glow against cool blue dusk, soft cinematic color, romantic and serene. No text, no cuts.

**Extend prompt (reuse every time, tweak lightly):**
They keep walking at the same calm pace, rain continuing, more lanterns and wooden townhouses
drifting past, reflections shimmering, same warm dusk light and gentle mood. No text, no cuts.

---

## Approach B — a real shot sequence (recommended for quality)

This is how actual music videos work: many short shots of the SAME world, cut together to the
song's structure. Generate 12-16 separate 8s clips (all plain text-to-video — no extends, so zero
drift), number them, and drop them all in chat. I assemble them in order, cut/crossfade between
shots, roughly aligned to the song's sections, and mux the track.

**Keep every prompt ending with this same style block so all shots match:**
> Rainy Kyoto canal at dusk, warm paper-lantern glow against cool blue twilight, gentle steady
> rain, soft cinematic color grade, romantic and serene. No text.

**Kyoto Rain shot list (2:40 song — intro/verse/chorus structure):**
1. *(Intro)* Fixed wide establishing shot of the canal, empty path, rain rippling the water, mist
   drifting, lanterns glowing. + style block
2. *(Intro)* Slow close-up: raindrops striking the canal surface, lantern light shimmering in the
   ripples. + style block
3. *(Verse 1)* Side-tracking shot: the couple walking under one clear umbrella, calm steady pace,
   townhouses drifting past. + style block
4. *(Verse 1)* Close shot from behind: their shoulders and the umbrella, rain sliding off its edge,
   canal beside them. + style block
5. *(Pre-chorus)* Low shot over the wet stone path, their feet walking side by side through
   shallow reflections. + style block
6. *(Chorus)* Wide slow push-in: the couple on a small wooden bridge, canal stretching away lined
   with glowing lanterns, rain streaking through the light. + style block
7. *(Chorus)* Slow upward tilt from the canal reflections to the couple laughing under the
   umbrella. + style block
8. *(Verse 2)* Through a teahouse window with steam on the glass: the couple passing outside,
   warm interior light in the foreground. + style block
9. *(Verse 2)* Close-up: her hand reaching from under the umbrella to catch raindrops. + style block
10. *(Pre-chorus)* Tracking shot low along the canal surface, ripples and lantern reflections
    streaming by. + style block
11. *(Chorus)* Wide: the couple slow-dancing a few steps under the umbrella beside the canal,
    rain glittering around them. + style block
12. *(Bridge — quiet)* Fixed still-like shot: the umbrella resting against a stone wall, rain
    softening, mist drifting over the water. + style block
13. *(Final chorus)* The widest most beautiful shot: full canal vista, lanterns doubled in the
    water, the couple small in frame walking into the glow. + style block
14. *(Outro)* Slow fade-friendly shot: rain easing on the empty path, lantern light flickering
    gently. + style block

Generate in any order; name the files `01.mp4` … `14.mp4` if you can. Missing a few is fine —
I'll reuse/hold shots to fill the runtime.

---

### Other themes — Approach A starting prompts (extend the same way)

**Neon club (dance):** Slow constant orbit around a packed rooftop nightclub stage at night, laser
beams sweeping, LED walls strobing to a 128 BPM beat, mirror ball scattering light, haze glowing,
skyline behind. High-energy saturated neon. No text, no cuts.

**Beach at dusk (love song):** Slow side-tracking shot along the waterline at golden dusk, waves
rolling and washing over the sand, warm light shimmering across the water, palms swaying, the sky
slowly deepening from gold to rose. Romantic and calm. No text, no cuts.

**Epic vista (orchestral):** Slow constant aerial glide over a vast stormy mountain valley, fog
rolling below, banners on ruins snapping in wind, embers streaming, lightning flickering inside
clouds, golden light breaking on the horizon. Epic cinematic scale. No text, no cuts.
