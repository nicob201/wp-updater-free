# WP Updater

[English](README.md) · **Español**

WP Updater es una herramienta gratuita que corre en tu computadora y mantiene al día todos tus sitios WordPress, en todos los servidores que quieras, desde una página web local. Se conecta a cada servidor por SSH, hace una copia de la base de datos de cada sitio y actualiza WordPress, plugins, temas y traducciones con WP-CLI. No hay nada que instalar en tus sitios, ni cuentas ni suscripciones.

![La vista Sites con tres sitios de demo esperando actualizaciones](docs/screenshot.png)

## Cómo funciona

- La herramienta corre en Docker en tu computadora y abre una página en `http://localhost:8787`. Solo tu computadora puede entrar.
- Entra a tus servidores con su propia clave SSH, que agregas una vez en cada servidor.
- En cada servidor busca los sitios WordPress en la carpeta personal de la cuenta y le pregunta a WP-CLI qué hay pendiente.
- No se instala nada en los sitios. Tu configuración, la clave SSH y las copias quedan en tu computadora, en la carpeta `data/`.

## Seguridad

- **Una copia verificada de la base de datos antes de cada sitio.** Si la copia falla o sale incompleta, ese sitio no se actualiza.
- **Los plugins, temas y sitios excluidos** nunca se actualizan.
- **Los duplicados nunca se actualizan.** Dos instalaciones que comparten base de datos o dirección quedan marcadas, y ninguna se actualiza hasta que excluyas una. Actualizar una copia actualizaría la base de datos del sitio en vivo.
- **Nunca corre como root.** Los archivos que escribe root quedan a nombre de root, y entonces WordPress no puede actualizarlos ni escribirlos, y el sitio se rompe. Si la cuenta del servidor es root, "Test connection" la rechaza.
- Después de cada sitio, la herramienta abre su dirección y espera una página que funcione.

> [!WARNING]
> Úsala bajo tu propia responsabilidad. Pruébala primero con la demo o con un sitio de staging.

## Requisitos

**En tu computadora:**

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (en Linux también sirve Docker Engine con el plugin de Compose)
- [git](https://git-scm.com/downloads)

**En cada servidor:**

- Acceso SSH con clave
- bash
- [WP-CLI](https://wp-cli.org/) (el comando `wp`)
- `mysqldump` o `mariadb-dump`
- `rsync`, solo para la copia completa

"Test connection" revisa todo esto y te dice qué falta. La mayoría de los hostings compartidos ya lo tienen.

## Inicio rápido

```sh
git clone https://github.com/nicob201/wp-updater-free.git
cd wp-updater-free
docker compose up -d
```

Abre <http://localhost:8787>.

La herramienta vuelve a arrancar sola cada vez que arranca Docker. Para detenerla, corre `docker compose down` en la misma carpeta: tu configuración, la clave y las copias se mantienen.

## Prueba la demo

La demo es un servidor de mentira con tres sitios WordPress desactualizados. Pruébala antes de conectar un servidor real.

1. Arráncala:

   ```sh
   docker compose --profile demo up -d
   ```

2. En la página, abre **Settings** → **Add server** y completa:
   - Name: `Demo`
   - Host: `demo`
   - Port: `22`
   - User: `demo`

   Haz clic en **Test connection**: dice OK. Después haz clic en **Save**. La demo ya confía en la clave de la herramienta, así que no hace falta agregarla.
3. Abre **Sites**. Vas a ver cuatro sitios. `site1` y `site1-old` aparecen como **Duplicate**: `site1-old` es una copia de `site1` que usa la misma base de datos, así que ninguno se actualiza.
4. Excluye la copia: en **Settings** → **Excluded sites**, marca **Exclude** al lado de `/home/demo/sites/site1-old`. De vuelta en **Sites**, `site1` ya se puede actualizar.
5. Haz clic en **Update all** y mira cómo cada sitio se respalda y se actualiza.

Para volver la demo a sus sitios desactualizados y probar de nuevo:

```sh
docker compose --profile demo up -d --force-recreate demo
```

Cuando termines, detenla con `docker compose --profile demo stop demo` y borra el servidor Demo en **Settings**.

## Conecta tu servidor

### 1. Copia la clave de la herramienta

Abre **Settings**. En **SSH key**, haz clic en **Copy**. Es una clave pública: puedes pegarla en el panel de tu hosting sin problema.

### 2. Agrega la clave a tu servidor

Agrégala a la cuenta dueña de tus sitios. En el formulario del servidor, la lista **Hosting** completa el puerto habitual y repite estos pasos.

#### Hostinger

1. En hPanel, abre **Advanced** → **SSH Access** (Avanzado → Acceso SSH).
2. Activa SSH si está apagado.
3. En **SSH keys**, agrega una clave y pega la de la herramienta.
4. En esa misma página están tu **IP** (el host), el **puerto** (normalmente `65002`) y el **usuario** (algo como `u123456789`).

#### cPanel

1. En cPanel, abre **Security** → **SSH Access** → **Manage SSH Keys**.
2. Haz clic en **Import Key**, ponle un nombre y pega la clave de la herramienta en el cuadro de la clave pública. Deja vacía la clave privada e impórtala.
3. De vuelta en la lista de claves, haz clic en **Manage** al lado de la clave nueva y después en **Authorize**.
4. El host es tu dominio, el usuario es tu usuario de cPanel y el puerto normalmente es `22`.

Algunos hostings apagan el SSH (acceso shell) o usan otro puerto. Si no conecta, pregúntale al soporte de tu hosting.

#### SiteGround

1. En Site Tools, abre **Devs** → **SSH Keys Manager**.
2. Abre **Import**, ponle un nombre a la clave, pega la de la herramienta e impórtala.
3. En la lista de claves, abre el menú de la clave → **SSH Credentials**: ahí están el host, el usuario y el puerto (normalmente `18765`).

#### VPS o servidor propio

1. Entra con la cuenta dueña de los archivos del sitio, no como root. Para ver de quién es un sitio, corre `ls -l` en su carpeta.
2. Agrega la clave a esa cuenta:

   ```sh
   mkdir -p ~/.ssh
   chmod 700 ~/.ssh
   echo 'PEGA-LA-CLAVE-AQUI' >> ~/.ssh/authorized_keys
   chmod 600 ~/.ssh/authorized_keys
   ```

3. El host es la dirección o IP del servidor, el puerto normalmente es `22` y el usuario es esa cuenta.

La herramienta busca los sitios en la carpeta personal de la cuenta, hasta 5 carpetas de profundidad. Si tus sitios están en otro lado, como `/var/www`, pon esa carpeta en **Sites path**. La cuenta tiene que poder entrar por SSH: una cuenta sin shell, como `www-data`, no sirve.

### 3. Agrega el servidor

En **Settings** → **Add server**, elige tu hosting, completa el nombre, host, puerto y usuario, y haz clic en **Test connection**. Cuando diga OK, haz clic en **Save**. Los sitios aparecen en **Sites** unos segundos después.

Puedes agregar todos los servidores que quieras. "Update all" los abarca a todos.

## Uso diario

- **Check for updates** le pregunta a cada servidor qué hay pendiente. También corre solo cuando arranca la herramienta, cuando cambias la configuración y después de cada actualización.
- Al lado de la dirección de cada sitio ves su versión de WordPress. Haz clic en un sitio para ver qué tiene pendiente: su versión actual y la nueva.
- **Can't update here**, debajo de los pendientes de un sitio, lista las actualizaciones que este servidor no puede aplicar, con el motivo, como "Needs PHP 8.3": la versión nueva necesita un WordPress o un PHP más nuevo que el del sitio. No cuentan como pendientes y la herramienta las saltea.
- **Update** actualiza ese sitio. **Update all** actualiza todos los sitios con actualizaciones pendientes, uno detrás de otro, en todos los servidores. Primero se respalda cada sitio y después se actualizan WordPress, plugins, temas y traducciones.
- Puedes cerrar la página mientras corre: la actualización sigue. Vuelve a abrir la página para ver el progreso y el registro en vivo.
- Un sitio marcado **Check** necesita que lo mires: su actualización falló o su página no cargó después. El motivo aparece al lado. Puedes actualizarlo de nuevo con su propio botón **Update**.
- **Excluded plugins & themes** (en **Settings**): agrega un plugin o tema por su slug, el nombre de su carpeta, como `elementor-pro`. Nunca se actualiza en ningún sitio, y sigue apareciendo en la lista de cada sitio, marcado como excluido. No hay nada excluido hasta que lo agregues.
- **Excluded sites** (en **Settings**): marca **Exclude** para dejar afuera un sitio. Nunca se revisa ni se actualiza, y no se corre nada en él.
- **Duplicate** significa que dos instalaciones comparten la misma base de datos o la misma dirección, normalmente una copia como un staging o una carpeta vieja. Ninguna se actualiza hasta que excluyas una de las dos.

## Copias y restauración

Las copias están en tu computadora, en la carpeta `data/backups`, una carpeta por servidor y por sitio:

```text
data/backups/<usuario>@<host>/<dirección del sitio>/
  database.sql.gz        la base de datos, de antes de la última actualización
  versions-before.txt    las versiones de plugins y temas antes de actualizar
```

Solo se guarda la última copia de cada sitio: cada actualización la reemplaza. Las carpetas `files/` de versiones anteriores se pueden borrar.

Para deshacer un solo plugin no hace falta restaurar todo. Entra al servidor, ve a la carpeta del sitio e instala la versión vieja que figura en `versions-before.txt`:

```sh
wp plugin install <plugin> --version=<versión vieja> --force
```

Para restaurar un sitio entero, corre estos comandos en la carpeta `wp-updater-free`. Usan la clave de la herramienta, así que funcionan en cualquier servidor que hayas agregado. Los ejemplos restauran el `site1` de la demo: cambia el usuario, host, puerto, carpeta de la copia y carpeta del sitio por los tuyos. **Settings** → **Excluded sites** muestra la carpeta de cada sitio debajo de su dirección.

### Restaura los archivos

Esto reemplaza los archivos del sitio por los de la copia y borra los que no están en ella. Mantiene el `wp-config.php` del servidor.

```sh
docker compose exec app rsync -az --delete --exclude /wp-config.php --exclude /wp-content/updraft --exclude /wp-content/wpvividbackups \
  -e "ssh -i /ssh/id_ed25519 -o UserKnownHostsFile=/ssh/known_hosts -p 22" \
  data/backups/demo@demo/site1.demo/files/ demo@demo:/home/demo/sites/site1/
```

### Restaura la base de datos

1. Sube la copia a la carpeta personal del servidor:

   ```sh
   docker compose exec app scp -i /ssh/id_ed25519 -o UserKnownHostsFile=/ssh/known_hosts -P 22 \
     data/backups/demo@demo/site1.demo/database.sql.gz demo@demo:restore.sql.gz
   ```

2. Entra al servidor:

   ```sh
   docker compose exec app ssh -i /ssh/id_ed25519 -o UserKnownHostsFile=/ssh/known_hosts -p 22 demo@demo
   ```

3. En el servidor, ve a la carpeta del sitio y carga la copia con los datos de acceso a la base del propio sitio:

   ```sh
   cd /home/demo/sites/site1
   export MYSQL_PWD="$(wp config get DB_PASSWORD)"
   gunzip -c ~/restore.sql.gz | mysql -h "$(wp config get DB_HOST)" -u "$(wp config get DB_USER)" "$(wp config get DB_NAME)"
   rm ~/restore.sql.gz
   wp cache flush
   exit
   ```

## Actualiza la herramienta

En la carpeta `wp-updater-free`:

```sh
git pull && docker compose up -d --build
```

Tu configuración, la clave y las copias se mantienen.

## Sin Docker (macOS y Linux)

Necesitas Node.js 24 o más nuevo, bash, ssh, rsync y curl. En la carpeta `wp-updater-free`:

```sh
node server.js
```

Abre <http://localhost:8787>. Todo se guarda en `data/`, incluida la clave en `data/ssh/`. Detenla con Ctrl+C. En Windows hace falta Docker.

## Problemas comunes

**El puerto ya está en uso.** Úsala en otro puerto, como el 9000, y abre <http://localhost:9000>:

```sh
WPU_PORT=9000 docker compose up -d
```

Para dejar ese puerto fijo, o en Windows, crea un archivo llamado `.env` en la carpeta `wp-updater-free` con la línea `WPU_PORT=9000` y corre `docker compose up -d`.

**"The server's host key has changed."** El servidor se reconstruyó o se reinstaló, así que tiene una identidad nueva. Si sabes por qué cambió, borra la vieja. Para un servidor en el puerto 22, usa su host:

```sh
docker compose exec app ssh-keygen -R example.com -f /ssh/known_hosts
```

Para cualquier otro puerto, escríbelo como `'[host]:puerto'`:

```sh
docker compose exec app ssh-keygen -R '[example.com]:65002' -f /ssh/known_hosts
```

Si no sabes por qué cambió, pregúntale a tu hosting antes de hacerlo: también puede significar que alguien se metió en el medio. Sin Docker, corre `ssh-keygen -R` con `-f data/ssh/known_hosts`.

**"Needs PHP 8.3", pero tu sitio ya usa PHP 8.3.** WP-CLI revisa el PHP que el servidor usa por SSH, y en los hostings compartidos puede ser más viejo que el de tu sitio. Pregúntale a tu hosting cómo usar un PHP más nuevo por SSH.

**"SSH rejected the key."** La clave de la herramienta todavía no está agregada en esa cuenta, o se agregó en otra. Cópiala de nuevo desde **Settings** y revisa el usuario. En cPanel, revisa que la clave esté autorizada.

**"WP-CLI (wp) is not installed."** Los hostings compartidos normalmente lo tienen. En un VPS, instálalo:

```sh
curl -O https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
php wp-cli.phar --info
chmod +x wp-cli.phar
sudo mv wp-cli.phar /usr/local/bin/wp
```

**"Can't write to the data folder."** No se puede guardar la configuración ni empezar una actualización, porque la herramienta no puede escribir en `data/`.

- En Linux, la herramienta escribe como el usuario con id 1000. Si tu usuario tiene otro id (míralo con `id -u`), dale la carpeta a ese id: `sudo chown -R 1000:1000 data`.
- En macOS con Colima, deja la carpeta `wp-updater-free` dentro de tu carpeta personal.

## Dónde se probó

| Dónde | Estado |
| --- | --- |
| macOS, con la demo | ✓ |
| Hostinger | ✓ listado (las actualizaciones se probaron en la demo) |
| Windows | pendiente |
| cPanel | sin probar todavía |
| SiteGround | sin probar todavía |
| VPS | sin probar todavía |

Si la pruebas en otro lado, abre un issue y cuenta cómo te fue.

## Cómo contribuir

- Corre los tests con `node --test test/*.test.js`. Solo necesitan Node.js 24 o más nuevo: no hay dependencias.
- Trabaja en una rama y abre un pull request contra `main`. Los tests y el build de Docker corren en cada pull request.
- Los mensajes de commit siguen [Conventional Commits](https://www.conventionalcommits.org/).

## Licencia

[MIT](LICENSE)
