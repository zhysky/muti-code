export function greet(name = "gateway") {
  return `hello ${name}`;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  console.log(greet());
}
