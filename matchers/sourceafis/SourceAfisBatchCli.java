import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;

import com.machinezoo.sourceafis.FingerprintImage;
import com.machinezoo.sourceafis.FingerprintImageOptions;
import com.machinezoo.sourceafis.FingerprintMatcher;
import com.machinezoo.sourceafis.FingerprintTemplate;

/**
 * Batch calibration bridge that loads every image once and emits a native
 * SourceAFIS score matrix. It is not used by the online comparison route.
 */
public final class SourceAfisBatchCli {
    private SourceAfisBatchCli() {
    }

    public static void main(String[] args) {
        if (args.length < 3) {
            fail("Usage: SourceAfisBatchCli <dpi> <image-1> <image-2> [...]");
        }
        try {
            double dpi = Double.parseDouble(args[0]);
            FingerprintTemplate[] templates = new FingerprintTemplate[args.length - 1];
            for (int index = 1; index < args.length; index++) {
                byte[] bytes = Files.readAllBytes(Path.of(args[index]));
                templates[index - 1] = new FingerprintTemplate(new FingerprintImage(
                    bytes, new FingerprintImageOptions().dpi(dpi)));
            }

            StringBuilder json = new StringBuilder();
            json.append("{\"scores\":[");
            for (int probe = 0; probe < templates.length; probe++) {
                if (probe > 0) json.append(',');
                json.append('[');
                FingerprintMatcher matcher = new FingerprintMatcher(templates[probe]);
                for (int reference = 0; reference < templates.length; reference++) {
                    if (reference > 0) json.append(',');
                    double score = matcher.match(templates[reference]);
                    if (!Double.isFinite(score)) fail("SourceAFIS returned a non-finite score.");
                    json.append(String.format(Locale.ROOT, "%.12f", score));
                }
                json.append(']');
            }
            json.append("]}");
            System.out.println(json);
        } catch (Throwable error) {
            fail(error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage()));
        }
    }

    private static void fail(String message) {
        System.err.println(message == null ? "Unknown SourceAFIS batch error." : message);
        System.exit(1);
    }
}
