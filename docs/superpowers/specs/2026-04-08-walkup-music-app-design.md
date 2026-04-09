# Walk-Up Music App — Design Spec

**Date:** 2026-04-08
**Project:** Baseball Walk-Up Music Web App
**Repo:** `walkup-app`
**Deployment:** GitHub Pages via GitHub Actions

## Purpose

A web app for playing walk-up music at a youth baseball game. A designated operator (or anyone with the URL) taps a player's name, hears a stadium-style "Now batting..." announcement, followed by that player's chosen walk-up song. Designed for use on a phone at the field, connected to a Bluetooth speaker.

## Roster

| # | Name |
|---|------|
| 5 | Adrian Stevanovic |
| 19 | Alexander Fiume |
| 7 | Axel Pettengell |
| 35 | Connor Nascimento |
| 9 | Devin Sen |
| 17 | Emmett Pitton |
| 10 | Everett Funston |
| 14 | Gregory Stratigopoulos |
| 36 | James Reason |
| 99 | Lincoln Shamliyan Bowen |
| 15 | Ozzy Day |
| 12 | Ryder Varrik |
| 78 | William Manz |

## Architecture

Single-page static app. No build step, no framework, no bundler.

### File Structure

```
walkup-app/
├── index.html
├── app.js
├── styles.css
├── roster.json
├── audio/
│   ├── announcements/
│   │   ├── 05-stevanovic.mp3
│   │   ├── 19-fiume.mp3
│   │   ├── 07-pettengell.mp3
│   │   ├── 35-nascimento.mp3
│   │   ├── 09-sen.mp3
│   │   ├── 17-pitton.mp3
│   │   ├── 10-funston.mp3
│   │   ├── 14-stratigopoulos.mp3
│   │   ├── 36-reason.mp3
│   │   ├── 99-shamliyan-bowen.mp3
│   │   ├── 15-day.mp3
│   │   ├── 12-varrik.mp3
│   │   └── 78-manz.mp3
│   └── walkups/
│       └── 19-fiume.mp3   (only song assigned so far)
├── .github/
│   └── workflows/
│       └── deploy.yml
└── docs/
    └── superpowers/
        └── specs/
            └── 2026-04-08-walkup-music-app-design.md
```

### roster.json

Single source of truth for player data.

```json
[
  {
    "number": 19,
    "firstName": "Alexander",
    "lastName": "Fiume",
    "announcement": "audio/announcements/19-fiume.mp3",
    "walkup": {
      "file": "audio/walkups/19-fiume.mp3",
      "startTime": 0,
      "duration": 15
    }
  },
  {
    "number": 5,
    "firstName": "Adrian",
    "lastName": "Stevanovic",
    "announcement": "audio/announcements/05-stevanovic.mp3",
    "walkup": null
  }
]
```

Players without a walk-up song have `"walkup": null`.

## UI Design

### Visual Theme

Baseball stadium at night. Dark background (#1a1a2e or similar deep navy), warm amber/gold accents (#f4a020), white and off-white text, subtle field-green highlights. Bold, condensed typography (system fonts to avoid load times).

### Two Modes (Tab Navigation)

**Roster View (default):**
- Grid of player cards (2 columns on phone, 3-4 on wider screens)
- Each card shows jersey number (large) and player name
- Music note icon on cards with a walk-up song configured
- Tap card → triggers playback sequence
- Active card glows with amber highlight

**Lineup View:**
- Tap players from the roster to add them to the batting order
- Ordered list with position numbers (1-13)
- "Now Batting" indicator on current batter
- "Next Batter" button advances and auto-plays
- Tap any player in lineup to jump to them
- Lineup persists in localStorage

### Playback Controls (Persistent Bottom Bar)

- Player name + number of currently playing
- Stop button (prominent, easy to hit)
- Volume slider
- Visual progress indicator

### Responsive Breakpoints

- **Phone (<600px):** Single column cards, bottom bar with essential controls
- **Tablet (600-1024px):** 2-column grid, full bottom bar
- **Desktop (>1024px):** 3-4 column grid, full bottom bar

## Audio Playback Logic

1. Any currently playing audio stops immediately (1s fade-out)
2. Announcement MP3 plays start to finish (~3-4s)
3. On announcement end, walk-up song starts at configured `startTime` (default 0s)
4. Song plays for configured `duration` (default 15s) with 2-second fade-out at end
5. If no duration set, plays until manually stopped
6. If no walk-up song configured, sequence ends after announcement
7. Manual stop triggers 1-second fade-out then silence

### Implementation

Two HTML5 `<audio>` elements: one for announcements, one for walk-up songs. Walk-up song is preloaded while announcement plays. Fade-out via JS interval adjusting volume property.

## Audio File Preparation

The concatenated announcement file is split using ffmpeg silence detection into 13 individual player announcement files. Files are named `{number}-{lastname}.mp3` with zero-padded two-digit numbers.

## Deployment

GitHub Actions workflow triggers on push to `main`. Deploys contents to GitHub Pages. No build step required — just copies files.

## Adding New Walk-Up Songs

1. Drop MP3 into `audio/walkups/` named `{number}-{lastname}.mp3`
2. Update `roster.json` with the walkup object (file path, startTime, duration)
3. Commit and push — GitHub Actions deploys automatically
