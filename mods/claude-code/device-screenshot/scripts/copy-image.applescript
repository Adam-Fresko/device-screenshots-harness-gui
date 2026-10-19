-- Puts the PNG at the path given as the first argument on the macOS clipboard, as an image.
on run argv
	set the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)
end run
