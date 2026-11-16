package main

import (
	"fmt"
	"io"
	"net/http"

	"go.bytecodealliance.org/wasi/wasihttp"
)

func init() {
	wasihttp.HandleFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		greeting := r.Header.Get("x-greeting")
		if greeting == "" {
			greeting = "none"
		}
		w.Header().Set("content-type", "text/plain; charset=utf-8")
		w.Header().Set("x-served-by", "go")
		if r.Method == http.MethodPost {
			w.WriteHeader(http.StatusCreated)
		}
		fmt.Fprintf(w, "method=%s\npath=%s\ngreeting=%s\n%s\nbody=%s\n",
			r.Method, r.URL.RequestURI(), greeting, greet(), body)
	})
}

func main() {}
