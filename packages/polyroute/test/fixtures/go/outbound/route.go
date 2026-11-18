package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"

	"go.bytecodealliance.org/wasi/wasihttp"
)

// Sends the request it receives to the URL in its `x-upstream` header, so tests
// can point it at a local server, and answers with what came back.
func init() {
	wasihttp.HandleFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		upstream, err := http.NewRequest(r.Method, r.Header.Get("x-upstream"), bytes.NewReader(body))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		upstream.Header.Set("x-sent-by", "go")
		response, err := wasihttp.DefaultClient.Do(upstream)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer response.Body.Close()
		text, err := io.ReadAll(response.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		w.Header().Set("x-upstream-status", fmt.Sprint(response.StatusCode))
		if contentType := response.Header.Get("content-type"); contentType != "" {
			w.Header().Set("content-type", contentType)
		}
		w.Write(text)
	})
}

func main() {}
