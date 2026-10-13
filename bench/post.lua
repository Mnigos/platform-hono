wrk.method = "POST"
wrk.body   = '{"name":"John Doe","email":"john@example.com","tags":["a","b","c"],"nested":{"x":1,"y":[1,2,3]}}'
wrk.headers["Content-Type"] = "application/json"
