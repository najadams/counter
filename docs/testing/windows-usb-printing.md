# Windows USB printing — test checklist

For the `feat/usb-printing` build. Run it on the Windows counter PC with the
packaged app, the receipt printer plugged in by USB, and no vendor driver.

## Get the build

1. GitHub → Actions → **Release** → the newest run on `feat/usb-printing` →
   Artifacts → download **counter-friendly-windows** (a zip with
   `Counter-Friendly-Setup-0.4.5-x64.exe`). Artifacts expire after 14 days.
2. Copy it to the PC. Close Counter Friendly if it's open. Run the installer
   (SmartScreen: *More info* → *Run anyway*). It installs over an earlier
   Counter Friendly and keeps its data; on a PC without it, it starts with
   activation and first-run setup (its own key — see CLAUDE.md §12).

## Before you start

- [ ] Printer switched on, paper loaded, USB cable in.
- [ ] Windows → Settings → Bluetooth & devices → **Printers & scanners**: note
      whether the printer appears by itself. Either way is fine. Write down
      what you see.

## A. Picking the printer (sign in as OWNER)

Settings → **Appearance** → Printers.

- [ ] Counter printer shows **USB / installed**, with a list headed
      *Printer on this computer*.
- [ ] **If Windows already showed the printer:** it's in the list, marked
      `· USB`. Pick it, press **Test print**, and a slip prints. Then skip to C.
- [ ] **If it isn't listed:** the panel says *No USB printer is installed* and
      shows **Set up USB receipt printer**. Go to B.

## B. One-click setup (no driver)

- [ ] Press **Set up USB receipt printer**. A Windows prompt asks to let
      PowerShell make changes. Choose **Yes**.
- [ ] The message says `"Counter Receipt" is ready on USB001` (or USB002…),
      and the list now shows *Counter Receipt · USB*, selected.
- [ ] Press **Test print**. A slip prints that ends *If you can read this,
      setup works.* and the paper is cut.
- [ ] Repeat the setup but choose **No** at the prompt. Counter says setup was
      cancelled, and nothing breaks.
- [ ] Press Set up again when *Counter Receipt* already exists. It reports
      ready without making a second printer.

## C. Real sales

- [ ] Door printer is on **Same as Counter**. Press its **Test print**, and
      the slip comes out of the same printer.
- [ ] Ring up a cash sale on the PC. The receipt prints, and the till isn't
      held up noticeably (time it: \_\_\_ s from Complete to the printed slip).
- [ ] Settings → **Phone access**: turn it on for the local network. If
      Windows Firewall asks, allow Counter Friendly on **private** networks.
      Join from a phone with the Home QR code and ring up a sale. Its receipt
      prints on the PC's printer.
- [ ] On the phone: Settings → Printers shows the PC's printers. **Set up USB
      receipt printer** refuses with *Set up the USB printer on the counter PC
      itself*.

## C2. Network printer and receipt layout

- [ ] Counter printer → **Network IP** → the printer's IP (port 9100) → Save →
      **Test print**. A slip prints.
- [ ] Receipts → Paper width **80 mm**: a sale receipt fills the paper's width,
      with the shop name and TOTAL printed tall. **58 mm** narrows it.
- [ ] Change Density and Use bold text, save, Test print: the slip changes.

## D. Failures stay loud

- [ ] Switch the printer **off** and ring up a sale. Note whether Counter
      reports a printer failure and the sale lands in Settings → Reprint queue,
      or whether the job sits in the Windows print queue. Write down which
      happened. Turn it back on and reprint from the queue.
- [ ] Pick a printer, then delete it in Windows Printers & scanners and press
      Refresh. The list marks it *not found on this computer*. Test print
      fails with *not installed in Windows*.

## Report back

- What Windows showed when the printer was plugged in, and its exact name.
- The result of each box, the print time, and what happened in D with the
  printer off.
- `%APPDATA%\Counter Friendly\logs\main.log` if anything failed.
