# toolya for Mac: quick start

This folder has `toolya` (root, mod install, shell) and `toolya-display`
(goggles as an external display). Nothing else to install.

In Terminal, from this folder, run this once after downloading (macOS blocks
downloaded tools until you do):

    xattr -dr com.apple.quarantine .

Then, with the goggles plugged in:

    ./toolya adb --yes                    # enable ADB / root
    ./toolya shell "id"                   # check: should say uid=0(root)

Install natartos from the `natartos-dist` download (unpacked next to this folder):

    ./toolya natartos install --local ../natartos-dist --mods overlay,popen,menu,stream,mute,launcher --yes
    ./toolya natartos start

Use the goggles as a Mac display:

    ./toolya-display

Close the toolya web page while using these. Only one program can hold the
goggles' USB connection at a time.
