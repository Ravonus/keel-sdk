function start(e) {
  let o = ["#FFD700", "#FF4500", "#6B8E23", "#8B4513", "#DEB887", "#5F9EA0", "#B22222", "#DAA520", "#BC8F8F", "#808080"], r = ["#000000", "#FFFFFF", "#00FFFF", "#FF00FF", "#FFFF00", "#1E90FF", "#32CD32", "#FFA500", "#9400D3", "#FF6347"], $ = document.createElement("canvas"); $.width = window.innerWidth, $.height = window.innerHeight, document.body.appendChild($); var t, i, a = $.getContext("webgl"); let n = Number(window.seed), c = o[n % o.length], d = r[n % r.length]; a || (alert("WebGL not supported, falling back on experimental-webgl"), a = $.getContext("experimental-webgl")), a || alert("Your browser does not support WebGL"); var l = 0, F = 0; function f(e, o = 1) { let r = parseInt(e.slice(1, 3), 16), $ = parseInt(e.slice(3, 5), 16), t = parseInt(e.slice(5, 7), 16); return [r / 255, $ / 255, t / 255, o] } $.addEventListener("mousemove", function (e) { var o = $.getBoundingClientRect(); l = e.clientX - o.left, F = e.clientY - o.top, l = l / $.width * 2.5 - 1, F = -(F / $.height * 2.5 - 1); var r = a.getUniformLocation(p, "mouse"); a.uniform2fv(r, [l, F]) }, !1); var s = Math.floor(n % 5e6) + 100, g = Array(s).fill(0), v = seedGen(Number(n) % 1e14)(), u = Number(n) % 1e9; for (t = 2; t < s; t++)if (0 == g[t]) for (i = t + t; i < s; i += t)g[i] = t; let h = n % 6500; h < 500 && (h += 500); let _ = n % 4 + .5; _ < 3 && (_ += 2); var m = `
              attribute vec2 coordinates;
              void main(void) {
                  gl_Position = vec4(coordinates, 500.0 * ${v}, ${h}.0 * ${v});
                  gl_PointSize = ${_};
              }`, A = a.createShader(a.VERTEX_SHADER); a.shaderSource(A, m), a.compileShader(A); var b = function e(o) {
    var r = ["if (length(coord) > 1.0) { discard; }", "if (length(coord) > 1.0 || coord.y < 0.0) { discard; }", "if (length(coord) > 1.0 || coord.y < 0.0 || coord.x < 0.0) { discard; }", "", "if (coord.y < abs(coord.x) - 1.0) { discard; }", "if (abs(coord.y) + abs(coord.x) > 1.0) { discard; }"], $ = r[Math.floor(o * r.length)]; let t = f(d), i = `vec4(${t[0]}, ${t[1]}, ${t[2]}, ${t[3]})`, a = `vec4(${5 * t[0]}, ${5 * t[1]}, ${5 * t[2]}, 1.0)`; return `
          precision mediump float;
          uniform vec2 mouse;
          void main(void) {
          vec2 coord = 2.0 * gl_PointCoord - 1.0;
          ${$}
          vec2 pointCoord = vec2(gl_FragCoord.x / 500.0 - 1.0, 1.0 - gl_FragCoord.y / 500.0);
          float dist = length(pointCoord - mouse);
          vec4 color = ${i};
          if (dist < 0.5) {
            color = ${a};
          }
          gl_FragColor = color;
        }`}(v), R = a.createShader(a.FRAGMENT_SHADER); a.shaderSource(R, b), a.compileShader(R); var p = a.createProgram(); a.attachShader(p, A), a.attachShader(p, R), a.linkProgram(p), a.useProgram(p); var B = a.createBuffer(); !function e() { var o = []; for (t = 2; t < s; t++)if (0 == g[t]) { var r = t * Math.sin(t * u) / 99, $ = t * Math.cos(t * u) / 93; o.push(r, $) } a.bindBuffer(a.ARRAY_BUFFER, B), a.bufferData(a.ARRAY_BUFFER, new Float32Array(o), a.DYNAMIC_DRAW), a.bindBuffer(a.ARRAY_BUFFER, null); let i = f(c); a.clearColor(...i), a.clear(a.COLOR_BUFFER_BIT), a.bindBuffer(a.ARRAY_BUFFER, B); var n = a.getAttribLocation(p, "coordinates"); a.vertexAttribPointer(n, 2, a.FLOAT, !1, 0, 0), a.enableVertexAttribArray(n); var d = a.getUniformLocation(p, "mouse"); a.uniform2fv(d, [l, F]), a.drawArrays(a.POINTS, 75, o.length / 3), u += -(1e-6 * v), requestAnimationFrame(e) }()
}