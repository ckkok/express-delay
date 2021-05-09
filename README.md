# Express Delay - An Express Meddleware

Do you have a lousy backend third-party service that you need to mock in your tests? Perhaps you need to figure out the right size of your http connection pools when your API needs to call that third-party backend service and it regularly responds via carrier pigeons?

## Requirements

Requires NodeJS v12.4.0 and above due to its usage of ES6 modules and contemporary JS language features.

## Some Design Decisions

We use [JSON5](https://json5.org/). The global JSON object is replaced by JSON5, so JSON.parse and JSON.stringify are automatically aware of JSON5 extensions. This is backwards compatible with existing JSON specifications. The main use case here is config documentation in the config.json5 file itself.

## Installation

Just run `npm install`. 

## Configuration

The following environment variables are used.

- `HOST`: Host for the server to listen on. Default: 0.0.0.0 (all network interfaces)
- `PORT`: Port for the server to listen on. Default: 3000
- `HTTP_PROXY`: Proxy for outgoing http requests

Edit `config.json` and add endpoints to the server. They will be registered at startup. The following options are available for each endpoint.

- `path`: *(required)* The server path, e.g. /status
- `headers`: An object containing the headers to be set in the response. Default: none.
- `cookies`: An object containing the cookies to be set in the response. Default: none.
- `delay`: Either a time in ms to delay the response for, or an object specifying the `min` and `max` delay in ms. Default: 0.
- `rate`: Max number of requests per second to this path. The server will return a status code of 429 once this is exceeded. Default: infinite.
- `status`: Status code for the response. Default: 200
- `cors`: A boolean specifying whether CORS is to be enabled for this path or not. Default: false
- `proxy`: The host to proxy requests to this path over to. Specifying this overrides the response configuration. Default: none.
- `response`: The filename of the response or handler. If the filename ends with .js, handlers will be imported from it - get, post, put, patch, delete methods exported from it are registered as their respective http methods. If the filename ends with .json or .html, their contents will be served with their respective content-type headers. Otherwise, they will be served as text/plain. Not specifying this field results in a response with no body. Default: null.

## Operation

Run `npm run start:win` on Windows, and `npm start` on MacOS/Linux.

The host, port, and server state are displayed together with all registered endpoints and methods and their corresponding requests per second. The display is updated every second.

At runtime, the following keypresses are available to alter the state of the server.

- left arrow / right arrow: Decrease / increase the proportion of 503 errors server-wide. Minimum and maximum proportions are 0 and 1 respectively.
- up arrow / down arrow: Increase / decrease the delay factor server-wide. Actual delay is equal to (configured delay * delay factor). Mininum delay factor is 0.
- pgup / pgdown: Increase / decrease server state id. This does nothing for the framework's infrastructure, but is exposed as a global for handlers to conditionally return different responses according to server state.

## Libraries Used

- `express` of course
- `express-http-proxy` for proxying requests to other backends
- `express-rate-limit` for API throttling
- `global-agent` for operating behind a corporate proxy
- `cors`