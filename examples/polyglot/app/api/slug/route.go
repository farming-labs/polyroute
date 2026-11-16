package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"unicode"

	"go.bytecodealliance.org/wasi/wasihttp"
)

// slugify lowercases text and joins its letter and digit runs with dashes.
func slugify(text string) string {
	words := strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	return strings.Join(words, "-")
}

func init() {
	wasihttp.HandleFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("allow", "GET")
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		text := r.URL.Query().Get("text")
		w.Header().Set("content-type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"text": text, "slug": slugify(text)})
	})
}

func main() {}
