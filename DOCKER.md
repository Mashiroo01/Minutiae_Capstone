# Docker setup

The Compose stack runs the PHP/Apache application, MariaDB, and the Node
fingerprint service. The fingerprint image builds Linux versions of NIST
Bozorth3 and the project's MINDTCT adapter, and uses the checked-in SourceAFIS
Java runtime.

## Start the stack

1. Create the local environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

2. Fill in both blank password values in `.env` with long, random secrets.
   Compose intentionally refuses to start while either value is blank.

3. Build and start the PHP application and MariaDB:

   ```powershell
   docker compose up --build -d
   ```

4. Start the real Windows ZKTeco service in a separate PowerShell window:

   ```powershell
   npm run scanner:start-real
   ```

   This command refuses to start unless the SDK adapter detects the physical
   ZK9500. Simulation is disabled in this mode.

5. Open <http://localhost:8080> and sign in with the admin credentials from
   `.env`.

Check the containers with:

```powershell
docker compose ps
docker compose logs -f web database
```

Stop the stack without deleting database data:

```powershell
docker compose down
```

To also delete the MariaDB volume and all application data:

```powershell
docker compose down --volumes
```

## Scanner and matcher notes

The checked-in ZKTeco capture adapter and the OpenAFIS/MCC/Jiang executables
are Windows binaries. The web container therefore calls the real fingerprint
service on the Windows host through `host.docker.internal:9000`. Modified
Bozorth3 runs through the host's Cygwin installation.

The Linux simulation service is now opt-in. Stop the real Windows service
first, then run it only when a hardware-free development session is needed:

```powershell
docker compose --profile simulation up -d fingerprint
```

The host service provides Modified Bozorth3 through Cygwin and can use the
checked-in Windows matcher adapters. Missing supporting matchers report
themselves as unavailable instead of being emulated.
