// Package canonical reproduces, byte-for-byte, the TS reference canonical serialization
// (src/audit/canonical.ts) + redaction (src/audit/redact.ts), so a Go-computed entryHash matches
// the TS one. It redacts BEFORE serializing (credentials never reach the hashed/chained bytes).
//
// Conformance is locked by TS-produced golden vectors (kernel/testdata/golden-vectors.json).
// This package does NOT hash, frame, or sign (that is internal/chain) and must not import it.
package canonical

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
)

// Redacted is the replacement token (must match src/audit/redact.ts REDACTED).
const Redacted = "[REDACTED]"

// Must match src/audit/redact.ts literally.
var (
	secretKeyRe = regexp.MustCompile(
		`(?i)(secret|password|passwd|token|api[_-]?key|apikey|authorization|bearer|credential|private[_-]?key|x-api-key)`)
	secretValueRe = regexp.MustCompile(
		`sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+`)
)

// CanonicalBytes redacts then deterministically serializes an event to UTF-8 bytes. It fails closed
// (returns an error) on values that the TS reference would reject (non-finite numbers, bigint-like
// numbers, unserializable types) — never silent coercion.
func CanonicalBytes(event any) ([]byte, error) {
	var b bytes.Buffer
	if err := writeValue(&b, redact(event)); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

// redact: by-KEY (value under a secret-like key -> REDACTED) + by-VALUE (secret-shape substrings
// scrubbed). Mirrors src/audit/redact.ts.
func redact(v any) any {
	switch x := v.(type) {
	case string:
		return secretValueRe.ReplaceAllString(x, Redacted)
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = redact(e)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, val := range x {
			if secretKeyRe.MatchString(k) {
				out[k] = Redacted
			} else {
				out[k] = redact(val)
			}
		}
		return out
	default:
		return v
	}
}

// writeValue mirrors src/audit/canonical.ts canonicalJson: sorted keys, JS-JSON.stringify-compatible
// string escaping, fail-closed on non-serializable values.
func writeValue(b *bytes.Buffer, v any) error {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case string:
		writeJSONString(b, x)
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return fmt.Errorf("canonical: non-finite number is not serializable")
		}
		b.WriteString(strconv.FormatFloat(x, 'g', -1, 64))
	case json.Number:
		i, err := x.Int64()
		if err != nil {
			return fmt.Errorf("canonical: number not an int64 (bigint-like, fail-closed): %s", x.String())
		}
		b.WriteString(strconv.FormatInt(i, 10))
	case []any:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := writeValue(b, e); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJSONString(b, k)
			b.WriteByte(':')
			if err := writeValue(b, x[k]); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	default:
		return fmt.Errorf("canonical: unserializable type %T", v)
	}
	return nil
}

// writeJSONString matches JS JSON.stringify string escaping: named escapes for \b\f\n\r\t, \u00xx
// for other control chars (<0x20), raw UTF-8 otherwise (non-ASCII NOT escaped).
func writeJSONString(b *bytes.Buffer, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}
