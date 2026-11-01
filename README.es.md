# Rebask PPR en Cloudflare Workers

Adaptador comunitario de **hipdev**, con licencia MIT. Publica el shell generado en
build y transmite después la continuación dinámica de React usando el runtime PPR
nativo de Rebask. No es un adaptador oficial de Rebask ni de Cloudflare.

**Experimental y con versiones exactas:** Rebask 0.2.0, Vite 8.3.5, Node 24 o superior.
[Guía completa y configuración](README.md) · [Para agentes](AGENTS.md).

## Instalación

```sh
npm install --save-exact @rebask/core@0.2.0 react@19.2.0 react-dom@19.2.0
npm install -D --save-exact @hipdev/rebask-cloudflare@0.1.0 vite@8.3.5 @vitejs/plugin-rsc@0.5.38 @vitejs/plugin-react@6.1.1 wrangler@4.156.0
```

En la configuración de Vite, después de `rsc()`, `react()` y `rebask()`, añade
`cloudflarePpr()` importado desde `@hipdev/rebask-cloudflare`. Usa el build nativo;
no combines este adaptador con Nitro, Vercel u otro adaptador en el mismo build.

En `rebask.config.ts` configura `cacheHandler: createCacheHandler()`, importando
esa función desde `@hipdev/rebask-cloudflare/cache`. Copia el `wrangler.jsonc` de
[examples/basic](examples/basic), cambia el nombre del Worker y ejecuta:

```sh
npx vite build
npx wrangler dev --config .output/server/wrangler.json
npx wrangler deploy --config .output/server/wrangler.json
```

En un monorepo ejecuta esos comandos desde la raíz de la aplicación Vite. Para
comparar proveedores, selecciona este plugin y esta configuración de Rebask solo
en el build de Cloudflare. El ejemplo mínimo no depende de servicios privados.

## Qué hace

Empaqueta en privado el manifiesto y los snapshots HTML/RSC del mismo build, junto
con su identificador de despliegue. Rebask encuentra el shell y reanuda React por
petición. La navegación puede aparecer antes de que termine el contenido dinámico,
si tu aplicación coloca las lecturas de sesión/request bajo Suspense local.
También incluye la corrección del trailer RSC necesaria para Node 24.

## Límites importantes

- Es PPR generado en build. Los snapshots se renuevan con cada despliegue.
- No implementa ISR durable, promoción dinámica ni caché compartida de `use cache`.
- Las escrituras de caché en runtime se ignoran; invalidar tags falla explícitamente.
- Las respuestas dinámicas son privadas/no-store. El adaptador no autoriza usuarios.
- El HTML reanudado viaja sin compresión para que Workerd no retenga el shell. Los
  assets y HTML estático completo conservan la compresión normal.
- No garantiza que desaparezcan todos los loaders locales ni un CLS igual a cero.
- Solo soporta el layout estándar de salida de Rebask 0.2.0 y configuración JSONC
  simple; los entornos Wrangler con nombre aún no están soportados.

## Deploy automático y verificación

Conecta tu repo a Workers Builds con rama `main`; usa `npm ci && npm run build` y
`npx wrangler deploy --config .output/server/wrangler.json`. Define como directorio
raíz el de la aplicación. Cada push vuelve a generar y desplegar los snapshots.

`npm test` comprueba almacenamiento y compatibilidad. `npm run test:integration`
instala el tarball en el ejemplo, construye con core sin parches externos y prueba
Workerd. Retrasa React 1800ms y verifica que la navegación llegue primero. Además
comprueba aislamiento entre peticiones, CSRF y tipos HTML/RSC. Ver [pruebas](docs/testing.md).
