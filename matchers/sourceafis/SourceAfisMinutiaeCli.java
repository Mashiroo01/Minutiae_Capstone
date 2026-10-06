import java.nio.file.Files;
import java.nio.file.Path;

import com.machinezoo.sourceafis.FingerprintImage;
import com.machinezoo.sourceafis.FingerprintImageOptions;
import com.machinezoo.sourceafis.FingerprintTemplate;

/**
 * Emits SourceAFIS' serialized feature template for use as a high-quality,
 * score-independent minutiae source by the OpenAFIS, MCC, and Jiang adapters.
 */
public class SourceAfisMinutiaeCli {
    public static void main(String[] args) throws Exception {
        if (args.length == 5 && "--pair".equals(args[0])) {
            double probeDpi = Double.parseDouble(args[1]);
            double referenceDpi = Double.parseDouble(args[2]);
            FingerprintTemplate probe = extract(Path.of(args[3]), probeDpi);
            FingerprintTemplate reference = extract(Path.of(args[4]), referenceDpi);
            System.out.println("[" + probe.serialize() + "," + reference.serialize() + "]");
            return;
        }
        if (args.length >= 3 && "--images".equals(args[0])) {
            double dpi = Double.parseDouble(args[1]);
            FingerprintImageOptions options = new FingerprintImageOptions().dpi(dpi);
            StringBuilder output = new StringBuilder("[");
            for (int index = 2; index < args.length; ++index) {
                FingerprintImage image = new FingerprintImage(Files.readAllBytes(Path.of(args[index])), options);
                FingerprintTemplate template = new FingerprintTemplate(image);
                if (index > 2) output.append(',');
                output.append(template.serialize());
            }
            output.append(']');
            System.out.println(output);
            return;
        }
        if (args.length == 2 && "--template".equals(args[0])) {
            FingerprintTemplate converted = new FingerprintTemplate().convert(Files.readAllBytes(Path.of(args[1])));
            System.out.println(converted.serialize());
            return;
        }
        if (args.length < 1 || args.length > 2) {
            fail("Usage: SourceAfisMinutiaeCli <image> [dpi] | --pair <probe-dpi> <reference-dpi> <probe> <reference> | --images <dpi> <image...> | --template <ISO-or-ANSI-template>");
        }
        double dpi = args.length == 2 ? Double.parseDouble(args[1]) : 500.0;
        FingerprintImageOptions options = new FingerprintImageOptions().dpi(dpi);
        FingerprintImage image = new FingerprintImage(Files.readAllBytes(Path.of(args[0])), options);
        FingerprintTemplate template = new FingerprintTemplate(image);
        System.out.println(template.serialize());
    }

    private static FingerprintTemplate extract(Path imagePath, double dpi) throws Exception {
        FingerprintImage image = new FingerprintImage(
            Files.readAllBytes(imagePath),
            new FingerprintImageOptions().dpi(dpi));
        return new FingerprintTemplate(image);
    }

    private static void fail(String message) {
        System.err.println(message);
        System.exit(1);
    }
}
