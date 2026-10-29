InnPilot - hotel operations and finance
=======================================

To install or upgrade InnPilot on this computer, double-click:  InnPilot-Install.cmd

What you need:
  - Windows 10 or 11 (64-bit), connected to the internet, set never to sleep while plugged in.
  - Docker Desktop (the installer offers to install it; free for businesses under 250 people
    and under US$10 million a year).
  - A free Tailscale account for the hotel, for its web address (https://...ts.net).
  - A USB stick for the recovery kit, and a folder for daily copies (Google Drive for desktop
    or a USB drive).

The first install asks for the hotel's address, name and owner, creates everything, and puts
an "InnPilot recovery kit" folder on the desktop: move it to a USB stick (instructions inside).

Running it again from a newer InnPilot bundle upgrades this computer; settings and data stay.
Stop InnPilot:  powershell -ExecutionPolicy Bypass -File install.ps1 -Stop
