//go:build !darwin

package notification

import (
	_ "embed"
)

//go:embed MOCHI-icon-solo.png
var Icon []byte
