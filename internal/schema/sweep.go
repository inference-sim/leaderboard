package schema

import (
	"math/rand"
	"strconv"
	"time"
)

// MintSweepID returns a short, time-ordered sweep id: "swp-" + base36(ms since epoch) +
// "-" + six base36 random chars. It mirrors the web app's mintSweepId (web/src/sweep.ts)
// so an id minted here and one minted in the browser share a format and sort order: the
// time component is lexicographically and numerically sortable, letting the By-sweep list
// order newest-first and read a date off the id, and the random suffix keeps two ids
// minted in the same millisecond distinct.
//
// Every run gets one. The web sweep path mints a single id shared by all its cells; a web
// single run and a CLI runs.yaml run leave it empty and the runner mints one here, so no
// record is ever written without a sweep_id (while the schema field stays optional, so
// records predating this still validate).
func MintSweepID() string {
	return mintSweepID(time.Now().UnixMilli(), rand.Int63())
}

// mintSweepID is the pure core, with the clock and randomness injected so the format and
// uniqueness are unit-testable.
func mintSweepID(unixMilli, randBits int64) string {
	suffix := strconv.FormatInt(randBits&0x7fffffff, 36)
	for len(suffix) < 6 {
		suffix = "0" + suffix
	}
	return "swp-" + strconv.FormatInt(unixMilli, 36) + "-" + suffix[:6]
}
