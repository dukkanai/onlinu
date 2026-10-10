package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// restaurantOpenPublicFile treats directory as a trusted, configured base.
// OpenRoot follows that base's symlinks; this does not establish the base's
// ownership or protect it from replacement before opening it. Below that base,
// reject hidden names and components observed as symlinks, then pin and verify
// opened identities. Serve that open file, never a pathname reopened later.
func restaurantOpenPublicFile(directory, name string) (*os.File, os.FileInfo, error) {
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, nil, err
	}
	defer root.Close()
	return restaurantOpenPublicFileInRoot(root, name, nil)
}

// afterLstat is nil in production. Tests use it to deterministically replace a
// checked component before it is opened, without scheduler-dependent races.
// The identity checks reject substitution with a different object. They do not
// establish immutable path ownership or prevent same-inode content changes,
// hard links, bind mounts, or other actions by malicious filesystem writers.
// In particular, a FIFO substituted after Lstat may block an open before the
// post-open checks run. Publication-directory writers must remain trusted.
func restaurantOpenPublicFileInRoot(root *os.Root, name string, afterLstat func(string)) (*os.File, os.FileInfo, error) {
	if !fs.ValidPath(name) || strings.Contains(name, `\`) {
		return nil, nil, fs.ErrNotExist
	}
	parts := strings.Split(name, "/")
	for _, part := range parts {
		if strings.HasPrefix(part, ".") {
			return nil, nil, fs.ErrNotExist
		}
		// Each root operation below must address exactly one component, including
		// on Windows, where separators, drive names and device names differ.
		if _, err := filepath.Localize(part); err != nil {
			return nil, nil, fs.ErrNotExist
		}
	}
	current := root
	defer func() {
		if current != root {
			_ = current.Close()
		}
	}()
	for i, part := range parts {
		before, err := current.Lstat(part)
		if err != nil {
			return nil, nil, err
		}
		leaf := i == len(parts)-1
		if before.Mode()&os.ModeSymlink != 0 || (leaf && !before.Mode().IsRegular()) || (!leaf && !before.IsDir()) {
			return nil, nil, fs.ErrNotExist
		}
		if afterLstat != nil {
			afterLstat(strings.Join(parts[:i+1], "/"))
		}
		if !leaf {
			next, err := current.OpenRoot(part)
			if err != nil {
				return nil, nil, err
			}
			opened, err := next.Stat(".")
			if err != nil || !opened.IsDir() || !os.SameFile(before, opened) {
				_ = next.Close()
				return nil, nil, fs.ErrNotExist
			}
			if current != root {
				_ = current.Close()
			}
			current = next
			continue
		}
		file, err := current.Open(part)
		if err != nil {
			return nil, nil, err
		}
		opened, err := file.Stat()
		if err != nil || !opened.Mode().IsRegular() || !os.SameFile(before, opened) {
			_ = file.Close()
			return nil, nil, fs.ErrNotExist
		}
		return file, opened, nil
	}
	return nil, nil, fs.ErrNotExist
}
