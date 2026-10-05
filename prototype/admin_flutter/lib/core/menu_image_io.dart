import 'dart:typed_data';
import 'package:file_selector/file_selector.dart';
import 'transport.dart';

class SelectedMenuImage {
  const SelectedMenuImage(this.name, this.bytes);
  final String name;
  final Uint8List bytes;
}

typedef MenuImagePicker = Future<SelectedMenuImage?> Function();

Future<SelectedMenuImage?> pickMenuImage() async {
  final file = await openFile(acceptedTypeGroups: const [
    XTypeGroup(
        label: 'PNG / JPEG',
        extensions: ['png', 'jpg', 'jpeg'],
        uniformTypeIdentifiers: ['public.png', 'public.jpeg'])
  ]);
  if (file == null) return null;
  if (await file.length() > BoundedCoreTransport.maxImageBytes)
    throw const CoreException('image_too_large');
  final builder = BytesBuilder(copy: false);
  await for (final chunk in file.openRead()) {
    if (builder.length + chunk.length > BoundedCoreTransport.maxImageBytes)
      throw const CoreException('image_too_large');
    builder.add(chunk);
  }
  final bytes = builder.takeBytes();
  validateMenuImage(bytes);
  return SelectedMenuImage(file.name, bytes);
}

void validateMenuImage(Uint8List bytes) {
  if (bytes.isEmpty || bytes.length > BoundedCoreTransport.maxImageBytes)
    throw const CoreException('image_too_large');
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  final isPng = bytes.length >= 8 &&
      List.generate(8, (i) => bytes[i] == png[i]).every((v) => v);
  final isJpeg = bytes.length >= 3 &&
      bytes[0] == 255 &&
      bytes[1] == 216 &&
      bytes[2] == 255;
  if (!isPng && !isJpeg) throw const CoreException('image_invalid');
}
