export const QUOTES = ["It is more important to have beauty in one's code than to have it pass the tests"]

export const getRandomQuote = () => {
	return QUOTES[Math.floor(Math.random() * QUOTES.length)]
}
