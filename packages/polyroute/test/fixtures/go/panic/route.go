package main

import (
	"net/http"

	"go.bytecodealliance.org/wasi/wasihttp"
)

func init() {
	wasihttp.HandleFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("fixture route panicked on purpose")
	})
}

func main() {}
